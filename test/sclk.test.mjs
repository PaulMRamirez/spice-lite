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
import { readTimeTable, withTimeTable } from './time-table.mjs';

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
const fwBytes = (base, sec, usec, context = 0) => {
  const b = new Uint8Array(11), v = new DataView(b.buffer);
  v.setUint16(0, base); v.setUint8(2, context); v.setUint32(3, sec); v.setUint32(7, usec);
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
    // Gaps are entries of the table but not pieces: they answer nothing.
    const pieces = report.time.filter((t) => t.base === fit.base && !t.gap);
    assert.equal(pieces.length, fit.pieces);
    assert.equal(report.time.filter((t) => t.base === fit.base && t.gap).length, fit.gaps ?? 0);
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
    // Past the window: a gap starts at the first reading after the last one
    // (the default), so the very next microsecond is out of coverage, in
    // every partition's stretch. An entry cut with "refuseGaps": false has no
    // gap, and its last piece is extended in a straight line; one second on,
    // that is still close to CSPICE.
    const top = fit.partitions.reduce((a, b) => (b.hostLast > a.hostLast ? b : a));
    const [ts, tu] = split(top.hostLast);
    if (fit.gaps) {
      for (const q of fit.partitions) {
        const after = Math.round(q.hostLast * 1e6) + 1;
        if (fit.partitions.some((o) => Math.round(o.hostFirst * 1e6) === after)) continue;
        assert.equal(api.host2et(fit.base, Math.floor(after / 1e6), after % 1e6).status, 1, `the reading after partition ${q.partition}'s last is refused`);
      }
      assert.equal(api.host2et(fit.base, ts + 1, tu).status, 1, 'one second past the window is refused');
    } else if (encoded(fit.sclk, top.partition, ts + 1, tu) !== null) await compare(top.partition, ts + 1, tu, 2 * tol, 'one second past the window');
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

test('mergeRecords joins pieces across coefficient records where the tolerance allows, and only there', { skip }, async () => {
  await setup();
  const cut = async (tol, mergeRecords) => slice(configFor('drift-merge', JUNE, [{ base: 3, sclk: -901, maxErrorSeconds: tol, mergeRecords }]), kernelDir, blobDir);
  // At a millisecond the drifting clock's rate changes (a tenth of a second
  // apart after a few weeks) and its 4 ms step keep every record its own piece.
  assert.equal((await cut(1e-3, true)).report.timeFit[0].pieces, 5);
  // At a second, records of one partition run together; the two partitions do not.
  const plain = await cut(1, false), merged = await cut(1, true);
  const [a, b] = [plain.report.timeFit[0], merged.report.timeFit[0]];
  assert.equal(a.pieces, 5);
  assert.ok(b.pieces < a.pieces && b.pieces >= b.partitions.length, `${b.pieces} pieces after merging, ${a.pieces} before`);
  assert.ok(b.maxErrSeconds <= 1);
  assert.deepEqual(b.partitions.map((q) => [q.partition, q.hostFirst, q.hostLast]), a.partitions.map((q) => [q.partition, q.hostFirst, q.hostLast]), 'the same readings are covered');
  console.log(line('drift, 30 days, merged at 1 s', merged.report, await check(merged.blob, merged.report, 903)));
  // Without the option the pieces are exactly what they were.
  assert.deepEqual((await cut(1e-6, false)).report.time, (await cut(1e-6, undefined)).report.time);
});

test('Unix time: a host that reports seconds since 1970 UTC, as F Prime\'s own time components do', { skip }, async () => {
  await setup();
  const { unixTimePieces } = await import('../tools/sclk-time.mjs');
  const utcOf = (sec, usec) => new Date(sec * 1000).toISOString().slice(0, 19) + '.' + String(usec).padStart(6, '0');
  // This test's truth is str2et on a calendar string, which is good to a few
  // units in the last place of ET (0.03 microseconds each in 2004, 0.06 in 2017).
  const PARSE = 2e-7;
  // Through the slicer and the library: TB_WORKSTATION_TIME is time base 2.
  const { blob, report } = await slice(configFor('unix', JUNE, [{ base: 2, unix: true, maxErrorSeconds: 1e-6 }]), kernelDir, blobDir);
  const fit = report.timeFit[0];
  assert.equal(fit.unix, true);
  assert.equal(fit.leapSeconds, 0);
  assert.ok(fit.maxErrSeconds <= 1e-6);
  assert.deepEqual([fit.partitions[0].hostFirst, fit.partitions[0].hostLast], [Date.UTC(2004, 5, 27) / 1000, Date.UTC(2004, 6, 27) / 1000], 'the window in Unix seconds');
  const api = await load(blob);
  assert.equal(api.initStatus, 0);
  const rnd = prng(41);
  let worst = 0;
  const readings = [[fit.partitions[0].hostFirst, 0], [fit.partitions[0].hostLast, 0]];
  for (let i = 0; i < 2000; i++) readings.push([fit.partitions[0].hostFirst + Math.floor(rnd() * 30 * 86400), Math.floor(rnd() * 1e6)]);
  for (const p of report.time.filter((q) => !q.gap)) { const [s0, u0] = split(p.hostStart); readings.push([s0, u0]); }
  for (const [sec, usec] of readings) {
    const got = api.host2et(2, sec, usec), want = await spice.str2et(utcOf(sec, usec));
    assert.equal(got.status, 0);
    assert.ok(Math.abs(got.et - want) <= 1e-6 + PARSE, `${utcOf(sec, usec)} is off by ${Math.abs(got.et - want)} s`);
    worst = Math.max(worst, Math.abs(got.et - want));
    const viaBytes = api.fwtime(fwBytes(2, sec, usec));
    assert.equal(viaBytes.et, got.et, 'the serialized F Prime time gives the same bits');
  }
  assert.equal(api.host2et(3, readings[5][0], 0).status, 1, 'the spacecraft time base is not in this blob');
  // By default the table ends with a gap one microsecond after the window's last reading.
  assert.equal(fit.gaps, 1);
  assert.equal(api.host2et(2, fit.partitions[0].hostLast, 1).status, 1, 'a microsecond past the window is refused');
  console.log(`  Unix time, 30 days: ${fit.pieces} pieces, slicer measured ${fit.maxErrSeconds.toExponential(2)} s, this test saw at most ${worst.toExponential(2)} s over ${readings.length} readings`);
  // Across a leap second (the one at the end of 2016): a piece starts at the
  // first reading after it, and the map steps by a second there.
  const window = [await spice.str2et('2016-12-25T00:00:00'), await spice.str2et('2017-01-08T00:00:00')];
  const leap = await unixTimePieces(spice, { base: 2, unix: true, maxErrorSeconds: 1e-6 }, window);
  const boundary = Date.UTC(2017, 0, 1) / 1000;
  assert.equal(leap.fit.leapSeconds, 1);
  assert.ok(leap.pieces.some((p) => p.hostStart === boundary), 'a piece starts at 2017-01-01T00:00:00');
  const evalAt = (host) => { const p = [...leap.pieces].reverse().find((q) => q.hostStart <= host); return p.etStart + p.rate * (host - p.hostStart); };
  for (const [sec, usec] of [[boundary - 1, 999999], [boundary, 0], [boundary + 1, 0], [boundary - 86400, 500000], [boundary + 86400, 500000]]) {
    const want = await spice.str2et(utcOf(sec, usec));
    assert.ok(Math.abs(evalAt(sec + usec * 1e-6) - want) <= 1e-6 + PARSE, `${utcOf(sec, usec)} across the leap second`);
  }
  assert.ok(Math.abs(evalAt(boundary) - evalAt(boundary - 1e-6) - 1) < 1e-4, 'ET steps by the leap second between the last reading of 2016 and the first of 2017');
  // A tolerance that is not a positive number is refused, as for a spacecraft clock.
  await assert.rejects(unixTimePieces(spice, { base: 2, unix: true, maxErrorSeconds: 0 }, window), /maxErrorSeconds must be a positive number/);
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

test('each derived piece carries the error measured for it, and holds it', { skip }, async () => {
  await setup();
  const tol = 1e-6;
  const { blob, report } = await slice(configFor('drift', JUNE, [{ base: 3, sclk: -901, maxErrorSeconds: tol }]), kernelDir, blobDir);
  // The pieces, without the gaps that end each stretch: a gap states no error.
  const table = readTimeTable(blob).filter((t) => !t.gap), fit = report.timeFit[0];
  const cut = report.time.filter((t) => !t.gap);
  assert.equal(table.length, fit.pieces);
  assert.ok(readTimeTable(blob).filter((t) => t.gap).every((t) => t.maxErr === 0));
  // Stored as 32-bit floats rounded up, so never below what was measured.
  table.forEach((t, i) => assert.ok(t.maxErr >= cut[i].maxErr && t.maxErr <= cut[i].maxErr * (1 + 2e-7) && t.maxErr > 0 && t.maxErr <= tol, `piece ${i}: ${t.maxErr}`));
  assert.equal(Math.max(...cut.map((t) => t.maxErr)), fit.maxErrSeconds, 'the worst piece is the fit\'s worst');
  assert.ok(Math.min(...table.map((t) => t.maxErr)) < 0.5 * fit.maxErrSeconds, 'and the pieces differ, which one number for the table could not say');
  // Every piece against CSPICE at readings of its own, to its own bound plus
  // the spacing of 64-bit ET values in 2004 (0.03 microseconds).
  const api = await load(blob), rnd = prng(905);
  const last = Math.max(...fit.partitions.map((q) => q.hostLast));
  let n = 0, tightest = 1;
  for (let i = 0; i < table.length; i++) {
    const from = Math.round(table[i].hostStart * 1e6), to = Math.round((i + 1 < table.length ? table[i + 1].hostStart : last) * 1e6);
    for (let k = 0; k < 400; k++) {
      const u = k === 0 ? from : from + Math.floor((to - from) * rnd());
      const [sec, usec] = [Math.floor(u / 1e6), u % 1e6];
      const enc = encoded(-901, 1, sec, usec) ?? encoded(-901, 2, sec, usec);
      if (enc === null) continue; // a count between the partitions, which the clock never showed
      const d = Math.abs(api.host2et(3, sec, usec).et - await spice.sct2e(-901, enc));
      assert.ok(d <= table[i].maxErr + 3e-8, `piece ${i} is off by ${d} s at ${sec}.${usec}, bound ${table[i].maxErr} s`);
      tightest = Math.min(tightest, table[i].maxErr - d); n++;
    }
  }
  console.log(`  ${table.length} pieces with bounds from ${Math.min(...table.map((t) => t.maxErr)).toExponential(2)} to ${Math.max(...table.map((t) => t.maxErr)).toExponential(2)} s; ${n} readings, each within its own piece's bound`);
  // An explicit piece may state a bound; one that states none stores zero.
  const stated = await slice(configFor('stated', JUNE, [{ base: 2, hostStart: 0, rate: 1, maxErrorSeconds: 2.5e-4 }, { base: 5, hostStart: 0, rate: 1 }]), kernelDir, blobDir);
  assert.deepEqual(readTimeTable(stated.blob).map((t) => t.maxErr), [Math.fround(2.5e-4) >= 2.5e-4 ? Math.fround(2.5e-4) : readTimeTable(stated.blob)[0].maxErr, 0]);
  assert.ok(readTimeTable(stated.blob)[0].maxErr >= 2.5e-4 && readTimeTable(stated.blob)[0].maxErr < 2.5e-4 * (1 + 2e-7));
});

test('gaps by default: counts the clock never showed, and readings past the window, are out of coverage; "refuseGaps": false leaves them open', { skip }, async () => {
  await setup();
  const entry = { base: 3, sclk: -901, maxErrorSeconds: 1e-6 };
  const open = await slice(configFor('drift-open', JUNE, [{ ...entry, refuseGaps: false }]), kernelDir, blobDir);
  const shut = await slice(configFor('drift', JUNE, [entry]), kernelDir, blobDir);
  assert.equal(open.report.timeFit[0].gaps, undefined);
  const fit = shut.report.timeFit[0];
  // Two gaps: after the first partition's last reading and after the window's.
  assert.equal(fit.gaps, 2);
  assert.equal(fit.pieces, open.report.timeFit[0].pieces, 'gaps are not counted as pieces');
  const table = readTimeTable(shut.blob), gaps = table.filter((t) => t.gap);
  assert.equal(table.length, fit.pieces + 2);
  const ends = fit.partitions.map((q) => q.hostLast).sort((x, y) => x - y);
  assert.deepEqual(gaps.map((g) => Math.round(g.hostStart * 1e6)), ends.map((h) => Math.round(h * 1e6) + 1), 'each gap starts one microsecond after a stretch ends');
  // The header says gaps exist; without that bit the same table is refused,
  // which is what a library from before gaps would do with the blob as cut.
  assert.equal(new DataView(shut.blob.buffer, shut.blob.byteOffset).getUint32(16, true) & 8, 8);
  assert.equal(new DataView(open.blob.buffer, open.blob.byteOffset).getUint32(16, true) & 8, 0);
  assert.equal((await load(withTimeTable(shut.blob, table, { headerFlags: 1 }))).initStatus, 4, 'a gap entry the header does not announce');
  const a = await load(open.blob), b = await load(shut.blob);
  assert.equal(b.initStatus, 0);
  // Inside the stretches both blobs give the same bits.
  const rnd = prng(906);
  let same = 0;
  for (const q of fit.partitions) {
    const [first, last] = [Math.round(q.hostFirst * 1e6), Math.round(q.hostLast * 1e6)];
    for (const u of [first, last, ...Array.from({ length: 500 }, () => first + Math.floor((last - first) * rnd()))]) {
      const x = a.host2et(3, Math.floor(u / 1e6), u % 1e6), y = b.host2et(3, Math.floor(u / 1e6), u % 1e6);
      assert.equal(y.status, 0);
      assert.equal(y.et, x.et);
      same++;
    }
  }
  // Between the partitions and past the window the open blob extends a line
  // and the shut one declines, from the first microsecond on, in either form.
  const [gapFrom, gapTo] = [Math.round(ends[0] * 1e6) + 1, Math.round(Math.min(...fit.partitions.map((q) => q.hostFirst).filter((h) => h > ends[0])) * 1e6) - 1];
  const past = Math.round(ends[1] * 1e6) + 1;
  let refused = 0;
  for (const u of [gapFrom, gapTo, Math.floor((gapFrom + gapTo) / 2), past, past + 1, past + 86400e6, 4294967295e6 + 999999]) {
    const [sec, usec] = [Math.floor(u / 1e6), u % 1e6];
    assert.equal(a.host2et(3, sec, usec).status, 0, 'the open blob answers anyway');
    assert.equal(b.host2et(3, sec, usec).status, 1, `${sec}.${usec} is refused`);
    assert.equal(b.fwtime(fwBytes(3, sec, usec)).status, 1);
    refused++;
  }
  assert.ok(gapTo - gapFrom > 1e6, 'the partitions are well apart');
  console.log(`  ${fit.pieces} pieces and ${fit.gaps} gaps; ${same} readings inside the stretches unchanged to the bit, ${refused} outside them refused`);
  // Unix time gets one gap, after the window.
  const unix = await slice(configFor('unix-gaps', JUNE, [{ base: 2, unix: true, maxErrorSeconds: 1e-3 }]), kernelDir, blobDir);
  const ut = readTimeTable(unix.blob);
  assert.equal(ut.filter((t) => t.gap).length, 1);
  assert.ok(ut[ut.length - 1].gap);
  const c = await load(unix.blob), [gs, gu] = split(ut[ut.length - 1].hostStart);
  assert.equal(c.host2et(2, gs, gu).status, 1);
  assert.equal(c.host2et(2, gs - 1, gu).status, 0);
  // An explicit gap: a base that stops answering at a stated reading.
  const hand = await slice(configFor('hand-gap', JUNE, [{ base: 2, hostStart: 0, rate: 1 }, { base: 2, hostStart: 1000, gap: true }, { base: 2, hostStart: 2000, etOffset: 2000, rate: 1 }]), kernelDir, blobDir);
  const d = await load(hand.blob);
  assert.deepEqual([999, 1000, 1999, 2000].map((sec) => d.host2et(2, sec, 0).status), [0, 1, 1, 0]);
});

test('context: a reset clock under one time base, told apart by the context byte', { skip }, async () => {
  await setup();
  // The clock of -902 was reset, so its two partitions show the same counts.
  // One base cannot tell them apart; two bases can; and so can one base with a
  // context per partition, which F Prime carries in the byte after the base.
  const time = [
    { base: 3, context: 1, sclk: -902, partition: 1, maxErrorSeconds: 1e-6 },
    { base: 3, context: 2, sclk: -902, partition: 2, maxErrorSeconds: 1e-6 },
  ];
  const { blob, report } = await slice(configFor('reset-context', JUNE, time), kernelDir, blobDir);
  assert.equal(new DataView(blob.buffer, blob.byteOffset).getUint32(16, true) & 4, 4, 'the header says pieces are selected by context');
  assert.deepEqual(report.timeFit.map((f) => [f.base, f.context, f.partitions.map((q) => q.partition)]), [[3, 1, [1]], [3, 2, [2]]]);
  const table = readTimeTable(blob);
  assert.deepEqual([...new Set(table.map((t) => t.context))], [1, 2]);
  const api = await load(blob), rnd = prng(907);
  assert.equal(api.initStatus, 0);
  let n = 0, shared = 0;
  for (const fit of report.timeFit) {
    const q = fit.partitions[0], other = report.timeFit.find((f) => f !== fit).partitions[0];
    const [first, last] = [Math.round(q.hostFirst * 1e6), Math.round(q.hostLast * 1e6)];
    for (let k = 0; k < 1000; k++) {
      const u = first + Math.floor((last - first) * rnd()), [sec, usec] = [Math.floor(u / 1e6), u % 1e6];
      const want = await spice.sct2e(-902, encoded(-902, q.partition, sec, usec));
      const got = api.fwtime(fwBytes(3, sec, usec, fit.context));
      assert.equal(got.status, 0);
      assert.ok(Math.abs(got.et - want) <= 1e-6, `partition ${q.partition}: off by ${Math.abs(got.et - want)} s`);
      // The three-argument call takes the context above the time base.
      assert.equal(api.host2et(3 + 65536 * fit.context, sec, usec).et, got.et);
      // The same count in the other partition is another time altogether.
      if (u >= Math.round(other.hostFirst * 1e6) && u <= Math.round(other.hostLast * 1e6)) {
        const there = api.fwtime(fwBytes(3, sec, usec, 3 - fit.context));
        assert.equal(there.status, 0);
        assert.ok(Math.abs(there.et - got.et) > 1, 'the two partitions give different times for one count');
        shared++;
      }
      n++;
    }
  }
  assert.ok(shared > 0, 'some counts occur in both partitions');
  // A context the blob has no pieces for, the bare base included, is out of
  // coverage; bits above the context are ignored.
  const [sec, usec] = split(report.timeFit[0].partitions[0].hostFirst + 10);
  for (const context of [0, 3, 255]) assert.equal(api.fwtime(fwBytes(3, sec, usec, context)).status, 1, `context ${context}`);
  assert.equal(api.host2et(3, sec, usec).status, 1);
  assert.equal(api.host2et(3 + 65536 + 2 ** 24, sec, usec).et, api.host2et(3 + 65536, sec, usec).et);
  console.log(`  ${table.length} pieces under base 3 in contexts 1 and 2; ${n} readings within a microsecond of CSPICE, ${shared} of them counts that both partitions show`);
  // The same two partitions without contexts still collide and are refused.
  await assert.rejects(slice(configFor('reset', JUNE, time.map(({ context, ...t }) => t)), kernelDir, blobDir), /two entries of time base 3 cover the same readings/);
  // In a blob that does not select by context, the context byte of an F Prime
  // time is ignored, as it always was.
  const plain = await slice(configFor('drift', JUNE, [{ base: 3, sclk: -901, maxErrorSeconds: 1e-6 }]), kernelDir, blobDir);
  const p = await load(plain.blob), [ps, pu] = split(plain.report.timeFit[0].partitions[0].hostFirst + 10);
  for (const context of [1, 7, 255]) assert.equal(p.fwtime(fwBytes(3, ps, pu, context)).et, p.host2et(3, ps, pu).et);
  assert.equal(p.host2et(3 + 65536 * 9, ps, pu).et, p.host2et(3, ps, pu).et);
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
