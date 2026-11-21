// TIME pieces derived from a spacecraft clock kernel (tools/sclk-time.mjs). For
// each test clock the slicer cuts a blob, then many host readings are converted
// by the library and by CSPICE (sct2e through cspice-wasm) and must agree within
// the tolerance the slicer declared for that blob.
//
// The reading to encoded SCLK step below is written out per clock from the
// constants in each kernel, by hand, and shares no code with the slicer, so a
// mistake in the slicer's reading of partitions or moduli shows up here.
//
// The clocks: cassini-demo.tsc from the cspice-wasm fixtures (a demonstration
// kernel: one partition, one record, TDB), and three SYNTHETIC kernels in
// test/fixtures (not real missions). Needs the kernels: set SPICE_LITE_KERNELS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { load, prng, root } from './harness.mjs';

const kernelDir = process.env.SPICE_LITE_KERNELS;
const blobDir = resolve(root, 'test/blobs');
const fixtures = ['naif0012.tls', 'de440s-inner-cassini.bsp', 'cassini-demo.tsc'];
const have = kernelDir && fixtures.every((k) => existsSync(resolve(kernelDir, k)));
const skip = !have && 'SPICE_LITE_KERNELS is not set or lacks the kernels';

// What each clock's kernel says, restated by hand: ticks per count of the most
// significant field, and for each partition its first tick, the encoded tick it
// starts at, and its length in ticks.
const CLOCKS = {
  '-82': { kernel: 'cassini-demo.tsc', ticks: 1000, parts: [{ raw: 0, enc: 0, len: 1e15 }] },
  '-901': { kernel: '../fixtures/synthetic-tt-drift.tsc', ticks: 256, parts: [{ raw: 0, enc: 0, len: 384000000 }, { raw: 2560000000, enc: 384000000, len: 1e12 }] },
  '-902': { kernel: '../fixtures/synthetic-tt-reset.tsc', ticks: 1000, parts: [{ raw: 0, enc: 0, len: 1.5e9 }, { raw: 0, enc: 1.5e9, len: 1e13 }] },
  '-903': { kernel: '../fixtures/synthetic-tt-steady.tsc', ticks: 65536, parts: [{ raw: 0, enc: 0, len: 281474976710650 }] },
};
// Encoded SCLK of a reading in a given partition (1-based), or null when the
// clock never shows that reading in that partition.
function encoded(sclk, partition, sec, usec) {
  const c = CLOCKS[sclk], p = c.parts[partition - 1];
  const ticks = ((sec * 1e6 + usec) * c.ticks) / 1e6 - p.raw;
  return ticks >= 0 && ticks < p.len ? ticks + p.enc : null;
}
const split = (host) => { const u = Math.round(host * 1e6); return [Math.floor(u / 1e6), u % 1e6]; };
const fwBytes = (base, sec, usec) => {
  const b = new Uint8Array(11), v = new DataView(b.buffer);
  v.setUint16(0, base); v.setUint32(3, sec); v.setUint32(7, usec);
  return b;
};

const body = {
  created: '2004-06-26T00:00:00',
  bodies: [{ id: 0, parent: null }, { id: 10, parent: 0, interval: 1382400, degree: 10 }],
};
const JUNE = { start: '2004-06-27T00:00:00', stop: '2004-07-27T00:00:00' };   // the periodic term is near an inflection
const MARCH = { start: '2004-03-20T00:00:00', stop: '2004-04-19T00:00:00' };  // and here near its peak, where it bends most
const configFor = (name, window, time) => ({
  name, ...structuredClone(body), window,
  kernels: ['naif0012.tls', 'de440s-inner-cassini.bsp', ...new Set(time.filter((t) => CLOCKS[t.sclk]).map((t) => CLOCKS[t.sclk].kernel))],
  time,
});

let spice, slice;
async function setup() {
  if (spice) return;
  ({ slice } = await import('../tools/slicer.mjs'));
  const { createSpiceEngine } = await import('cspice-wasm');
  spice = await createSpiceEngine();
  await spice.furnsh('naif0012.tls', new Uint8Array(readFileSync(resolve(kernelDir, 'naif0012.tls'))));
  for (const c of Object.values(CLOCKS)) {
    const path = resolve(c.kernel.startsWith('.') ? blobDir : kernelDir, c.kernel);
    await spice.furnsh(c.kernel.split('/').pop(), new Uint8Array(readFileSync(path)));
  }
}

// Compares the library with CSPICE over one sliced blob: random readings in
// every partition the report lists, every piece boundary and the reading just
// before it, the ends of each partition's stretch, readings just outside, and
// the serialized F Prime form. Returns the worst error seen.
async function check(blob, report, seed) {
  const api = await load(blob);
  assert.equal(api.initStatus, 0);
  const rnd = prng(seed);
  let worst = 0, n = 0;
  for (const fit of report.timeFit) {
    const pieces = report.time.filter((t) => t.base === fit.base);
    assert.equal(pieces.length, fit.pieces);
    assert.ok(fit.maxErrSeconds <= fit.toleranceSeconds, 'the slicer met its own tolerance');
    const compare = async (partition, sec, usec, bound, what) => {
      const enc = encoded(fit.sclk, partition, sec, usec);
      assert.notEqual(enc, null, `${what}: ${sec}.${usec} is not a reading of partition ${partition}`);
      const want = await spice.sct2e(fit.sclk, enc);
      const got = api.host2et(fit.base, sec, usec);
      assert.equal(got.status, 0, what);
      const d = Math.abs(got.et - want);
      assert.ok(d <= bound, `${what}: clock ${fit.sclk} reading ${sec}.${String(usec).padStart(6, '0')} is off by ${d} s, bound ${bound} s`);
      worst = Math.max(worst, d); n++;
      return got.et;
    };
    const tol = fit.toleranceSeconds;
    for (const part of fit.partitions) {
      const [s0, u0] = split(part.hostFirst), [s1, u1] = split(part.hostLast);
      const first = s0 * 1e6 + u0, last = s1 * 1e6 + u1;
      for (let i = 0; i < 2000; i++) {
        const u = first + Math.floor((last - first) * rnd());
        await compare(part.partition, Math.floor(u / 1e6), u % 1e6, tol, 'random reading');
      }
      // The microsecond field at its extremes inside the stretch.
      for (const usec of [0, 1, 499999, 999999]) await compare(part.partition, s0 + 1, usec, tol, 'microsecond field');
      // The stretch's own ends, and the ET they map to against the window.
      const etFirst = await compare(part.partition, s0, u0, tol, 'first reading');
      const etLast = await compare(part.partition, s1, u1, tol, 'last reading');
      assert.ok(etFirst >= report.windowEt[0] - tol - 2e-6 && etLast <= report.windowEt[1] + tol + 2e-6, 'the stretch lies inside the window');
      // Every piece boundary inside this stretch: the boundary reading itself
      // and the reading one microsecond earlier, which belongs to the piece before.
      for (const p of pieces) {
        if (p.hostStart < part.hostFirst || p.hostStart > part.hostLast) continue;
        const [bs, bu] = split(p.hostStart);
        await compare(part.partition, bs, bu, tol, 'piece boundary');
        const before = bs * 1e6 + bu - 1;
        if (before >= first) await compare(part.partition, Math.floor(before / 1e6), before % 1e6, tol, 'reading before a piece boundary');
      }
    }
    // Just outside. Below the base's first piece there is nothing to select.
    const lowest = Math.min(...pieces.map((p) => p.hostStart));
    const [ls, lu] = split(lowest);
    const below = ls * 1e6 + lu - 1;
    if (below >= 0) assert.equal(api.host2et(fit.base, Math.floor(below / 1e6), below % 1e6).status, 1, 'a reading below the first piece is out of coverage');
    assert.equal(api.host2et(fit.base + 40, ls, lu).status, 1, 'an unknown time base is out of coverage');
    assert.equal(api.host2et(fit.base, ls + 1, 1000000).status, 6, 'a microsecond field of a million is refused');
    // Past the window the last piece of a partition is extended in a straight
    // line; one second on, that is still close to CSPICE.
    const top = fit.partitions.reduce((a, b) => (b.hostLast > a.hostLast ? b : a));
    const [ts, tu] = split(top.hostLast);
    if (encoded(fit.sclk, top.partition, ts + 1, tu) !== null) await compare(top.partition, ts + 1, tu, 2 * tol, 'one second past the window');
    // The serialized F Prime time gives the same bits as the three arguments.
    const mid = fit.partitions[0];
    const [ms, mu] = split((mid.hostFirst + mid.hostLast) / 2);
    const a = api.host2et(fit.base, ms, mu), b = api.fwtime(fwBytes(fit.base, ms, mu));
    assert.equal(b.status, 0);
    assert.equal(a.et, b.et);
  }
  return { worst, n };
}

const line = (label, report, seen) => report.timeFit.map((f) =>
  `  ${label}: base ${f.base}, clock ${f.sclk} (${f.timeSystem}) at ${f.toleranceSeconds} s: ${f.pieces} pieces, slicer measured ${f.maxErrSeconds.toExponential(2)} s`).join('\n') +
  `\n  ${label}: this test saw at most ${seen.worst.toExponential(2)} s over ${seen.n} readings`;

test('the committed sclk-drift blob: four rates, a step, and two partitions, to a microsecond', { skip }, async () => {
  await setup();
  const report = JSON.parse(readFileSync(resolve(blobDir, 'sclk-drift.report.json'), 'utf8'));
  const blob = new Uint8Array(readFileSync(resolve(blobDir, 'sclk-drift.slb')));
  const fit = report.timeFit[0];
  assert.equal(fit.partitions.length, 2);
  // Lines must start at the partition boundary and at the three later records.
  const starts = report.time.map((t) => t.hostStart);
  for (const s of [1000000, 10000000, 10500000, 11500000]) assert.ok(starts.includes(s), `a piece starts at count ${s}`);
  console.log(line('sclk-drift, 30 days', report, await check(blob, report, 901)));
});

test('the committed sclk-many blob: about two hundred pieces, each found by the search, to a tenth of a microsecond', { skip }, async () => {
  await setup();
  const report = JSON.parse(readFileSync(resolve(blobDir, 'sclk-many.report.json'), 'utf8'));
  const blob = new Uint8Array(readFileSync(resolve(blobDir, 'sclk-many.slb')));
  const fit = report.timeFit[0];
  assert.equal(fit.toleranceSeconds, 1e-7);
  assert.ok(fit.pieces >= 200, `${fit.pieces} pieces`);
  // Other time bases sit below and above the clock's in the sorted table.
  assert.deepEqual([...new Set(report.time.map((t) => t.base))], [2, 3, 5]);
  console.log(line('sclk-many, 240 days', report, await check(blob, report, 905)));
  // The explicit pieces of the neighboring bases answer as written.
  const api = await load(blob);
  const w0 = report.windowEt[0];
  assert.equal(api.host2et(2, 100, 500000).et, w0 + 100.5);
  assert.equal(api.host2et(2, 5000010, 0).et, w0 + 5000000.25 + 0.999999 * 10);
  assert.equal(api.host2et(5, 133000007, 0).et, w0 + 7);
  assert.equal(api.host2et(5, 132999999, 999999).status, 1);
  assert.equal(api.host2et(4, 133000007, 0).status, 1);
});

test('the same clock to a millisecond needs only the structural pieces', { skip }, async () => {
  await setup();
  const { blob, report } = await slice(configFor('drift-ms', JUNE, [{ base: 3, sclk: -901, maxErrorSeconds: 1e-3 }]), kernelDir, blobDir);
  assert.equal(report.timeFit[0].pieces, 5);
  console.log(line('drift, 30 days', report, await check(blob, report, 902)));
});

test('the cassini-demo clock is one line', { skip }, async () => {
  await setup();
  for (const tol of [1e-6, 1e-3]) {
    const { blob, report } = await slice(configFor('cassini-demo', JUNE, [{ base: 3, sclk: -82, maxErrorSeconds: tol }]), kernelDir, blobDir);
    assert.equal(report.timeFit[0].pieces, 1);
    console.log(line('cassini-demo, 30 days', report, await check(blob, report, 82)));
  }
});

test('a steady clock on TT: the periodic TDB term sets the piece count', { skip }, async () => {
  await setup();
  const count = {};
  for (const [name, window] of [['June', JUNE], ['March', MARCH]]) {
    for (const tol of [1e-6, 1e-3]) {
      const { blob, report } = await slice(configFor('steady', window, [{ base: 3, sclk: -903, maxErrorSeconds: tol }]), kernelDir, blobDir);
      count[`${name} ${tol}`] = report.timeFit[0].pieces;
      console.log(line(`steady, 30 days from ${window.start.slice(0, 10)}`, report, await check(blob, report, 903)));
    }
  }
  assert.equal(count['June 0.001'], 1);
  assert.equal(count['March 0.001'], 1);
  assert.ok(count['March 0.000001'] > 1 && count['March 0.000001'] <= 12, `${count['March 0.000001']} pieces`);
});

test('a reset clock: one base is refused, one base per partition works, and explicit pieces pass through', { skip }, async () => {
  await setup();
  await assert.rejects(
    slice(configFor('reset', JUNE, [{ base: 3, sclk: -902, maxErrorSeconds: 1e-6 }]), kernelDir, blobDir),
    /partitions 1 and 2 share clock readings/);
  const time = [
    { base: 3, sclk: -902, partition: 1, maxErrorSeconds: 1e-6 },
    { base: 4, sclk: -902, partition: 2, maxErrorSeconds: 1e-6 },
    { base: 2, hostStart: 0, etOffset: 5, rate: 1.0 },
  ];
  const { blob, report } = await slice(configFor('reset', JUNE, time), kernelDir, blobDir);
  assert.deepEqual(report.timeFit.map((f) => f.partitions.map((p) => p.partition)), [[1], [2]]);
  console.log(line('reset, 30 days', report, await check(blob, report, 904)));
  // The explicit entry is written exactly as before: measured from the window start.
  const api = await load(blob);
  assert.equal(api.host2et(2, 100, 500000).et, report.windowEt[0] + 5 + 100.5);
  assert.deepEqual(report.time.filter((t) => t.base === 2), [{ base: 2, hostStart: 0, etStart: report.windowEt[0] + 5, rate: 1 }]);
});

test('the slicer fails clearly instead of missing its bound', { skip }, async () => {
  await setup();
  const cut = (entry, window = JUNE) => slice(configFor('fail', window, [{ base: 3, ...entry }]), kernelDir, blobDir);
  await assert.rejects(cut({ sclk: -901, maxErrorSeconds: 1e-6, maxPieces: 3 }), /more than 3 linear pieces are needed to hold 0.000001 s/);
  await assert.rejects(cut({ sclk: -901, maxErrorSeconds: 1e-12 }), /linear pieces are needed|could not hold/);
  await assert.rejects(cut({ sclk: -77, maxErrorSeconds: 1e-6 }), /no furnished kernel defines spacecraft clock -77/);
  await assert.rejects(cut({ sclk: -901, maxErrorSeconds: 0 }), /maxErrorSeconds must be a positive number/);
  await assert.rejects(cut({ sclk: -901, partition: 7, maxErrorSeconds: 1e-6 }), /partition 7 does not exist/);
  // The drift clock starts on 2004-06-20; a window before that is not covered.
  await assert.rejects(cut({ sclk: -901, maxErrorSeconds: 1e-6 }, { start: '2004-06-01T00:00:00', stop: '2004-06-25T00:00:00' }), /does not cover the blob's window/);
});
