// Tier C, robustness: corrupted and truncated blobs must be refused or handled
// with status codes. The native run under AddressSanitizer and
// UndefinedBehaviorSanitizer catches any out-of-bounds read; the WebAssembly
// run shows that nothing traps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { load, prng, root } from './harness.mjs';

const blobPath = resolve(root, 'test/blobs/cassini-soi.slb');
const blob = new Uint8Array(readFileSync(blobPath));
const san = resolve(root, 'build/driver-san');

test('200,000 corrupted blobs under the sanitizers: no faults', { skip: !existsSync(san) && 'build/driver-san not built' }, () => {
  const out = execFileSync(san, ['fuzz', blobPath, '200000', '20261120'], { encoding: 'utf8' });
  assert.match(out, /no faults/);
  console.log('  ' + out.trim());
});

test('a single flipped bit anywhere is caught by the checksum', async () => {
  const rnd = prng(5);
  for (let i = 0; i < 300; i++) {
    const copy = blob.slice();
    const pos = 16 + Math.floor(rnd() * (copy.length - 16));
    copy[pos] ^= 1 << Math.floor(rnd() * 8);
    assert.equal((await load(copy)).initStatus, 4, `flip at byte ${pos}`);
  }
});

test('corrupted blobs never trap the WebAssembly build', async () => {
  const rnd = prng(11);
  const t = new DataView(blob.buffer).getFloat64(24, true) + 86400;
  let accepted = 0;
  for (let i = 0; i < 400; i++) {
    let copy = blob.slice();
    if (i % 10 === 0) copy = copy.slice(0, Math.floor(rnd() * copy.length));
    for (let e = 0; e < 3 && copy.length; e++) copy[Math.floor(rnd() * Math.min(copy.length, 2048))] = Math.floor(rnd() * 256);
    const api = await load(copy, { skipCrc: true });
    if (api.initStatus === 0) accepted++;
    for (const [a, b] of [[301, 399], [-82, 6], [10, 0], [5, 5]]) {
      api.state(a, b, t, 0); api.state(a, b, t, 2); api.orient(a, t); api.siteView(1, a, t, 0);
    }
    api.host2et(3, 10, 0);
  }
  console.log(`  400 corrupted blobs, ${accepted} accepted with the checksum skipped, no traps`);
});

test('calls before a blob is active report a bad blob', async () => {
  const api = await load(new Uint8Array(8));
  assert.equal(api.initStatus, 4);
  assert.equal(api.state(301, 399, 0, 0).status, 4);
  assert.equal(api.orient(301, 0).status, 4);
  assert.equal(api.host2et(3, 0, 0).status, 4);
  assert.equal(api.clearState(), 4);
});

// ---- the TIME section: order, overlap, and the search -----------------------
//
// lite_host2et finds its piece by binary search, so lite_init must refuse any
// TIME section that is not sorted by time base, then host_start, with no two
// pieces of one base starting together. The tests below hand the library
// tables in every wrong order with a valid checksum, and hold the search to a
// scan of every entry on tables it accepts.
import { readTimeTable, withTimeTable, timeSorted, hostScan } from './time-table.mjs';

const manyPath = resolve(root, 'test/blobs/sclk-many.slb');
const many = new Uint8Array(readFileSync(manyPath));
const drift = new Uint8Array(readFileSync(resolve(root, 'test/blobs/sclk-drift.slb')));
const sameBits = (a, b) => Object.is(a, b);

test('200,000 corrupted copies of the many-piece blob under the sanitizers: no faults, the search matches a scan', { skip: !existsSync(san) && 'build/driver-san not built' }, () => {
  const out = execFileSync(san, ['fuzz', manyPath, '200000', '20261121'], { encoding: 'utf8' });
  assert.match(out, /no faults/);
  const m = out.match(/(\d+) were out of order or not finite and refused, (\d+) were still sorted and accepted; (\d+) conversions matched/);
  assert.ok(m && +m[1] > 1000 && +m[2] > 1000 && +m[3] > 100000, out);
  console.log('  ' + out.trim().split('\n').join('\n  '));
});

test('every committed blob has a sorted TIME section and still loads', async () => {
  for (const name of ['cassini-soi', 'sun-earth-moon', 'sclk-drift', 'sclk-many', 'eclipses', 'saturn-soi', 'orbiter']) {
    const bytes = new Uint8Array(readFileSync(resolve(root, `test/blobs/${name}.slb`)));
    assert.ok(timeSorted(readTimeTable(bytes)), `${name}: TIME is sorted`);
    assert.equal((await load(bytes)).initStatus, 0, name);
  }
});

test('an unsorted TIME section is a bad blob, with a valid checksum', async () => {
  for (const [name, blobBytes] of [['sclk-drift', drift], ['sclk-many', many]]) {
    const table = readTimeTable(blobBytes);
    const n = table.length;
    // The table rewritten unchanged still loads, so a refusal below is the order.
    const same = await load(withTimeTable(blobBytes, table));
    assert.equal(same.initStatus, 0, `${name}: the same table, rewritten`);
    const swap = (i, j) => { const t = table.slice(); [t[i], t[j]] = [t[j], t[i]]; return t; };
    const cases = {
      'the first two swapped': swap(0, 1),
      'the last two swapped': swap(n - 2, n - 1),
      'two in the middle swapped': swap(n >> 1, (n >> 1) + 1),
      'the first and last swapped': swap(0, n - 1),
      'reversed': table.slice().reverse(),
      'rotated by one': [...table.slice(1), table[0]],
      'sorted by start alone, bases mixed': table.map((t, i) => ({ ...t, base: i % 2 ? 3 : 4 })),
      'a later base first': [{ base: 7, hostStart: 0, etStart: 0, rate: 1 }, ...table],
      'an earlier base last': [...table, { base: 0, hostStart: 0, etStart: 0, rate: 1 }],
    };
    for (const [what, t] of Object.entries(cases)) {
      assert.ok(!timeSorted(t), `${name}: ${what} is out of order`);
      const api = await load(withTimeTable(blobBytes, t));
      assert.equal(api.initStatus, 4, `${name}: ${what}`);
      assert.equal(api.host2et(3, 100, 0).status, 4, `${name}: ${what}: no conversion from a refused blob`);
    }
  }
});

test('overlapping TIME pieces (two of one base starting together) are a bad blob', async () => {
  const table = readTimeTable(drift);
  const mid = table[3];
  const cases = {
    'an entry twice in a row': [...table.slice(0, 4), { ...mid }, ...table.slice(4)],
    'the same start with another line': [...table.slice(0, 4), { ...mid, etStart: mid.etStart + 1, rate: 0.5 }, ...table.slice(4)],
    'the first entry twice': [{ ...table[0] }, ...table],
    'the last entry twice': [...table, { ...table[table.length - 1] }],
    'starts of plus and minus zero': [{ base: 1, hostStart: -0, etStart: 0, rate: 1 }, { base: 1, hostStart: 0, etStart: 5, rate: 1 }, ...table],
    'a start that is not a number': [...table.slice(0, 2), { ...table[2], hostStart: NaN }, ...table.slice(3)],
    'an infinite start at the end': [...table, { base: 9, hostStart: Infinity, etStart: 0, rate: 1 }],
  };
  for (const [what, t] of Object.entries(cases)) assert.equal((await load(withTimeTable(drift, t))).initStatus, 4, what);
  // The neighbors of those cases that are in order do load: the same base one
  // microsecond later, the same start under the next base, and a negative start.
  const ok = {
    'a microsecond later': [...table.slice(0, 4), { ...mid, hostStart: mid.hostStart + 1e-6 }, ...table.slice(4)],
    'the same start under the next base': [...table, { ...mid, base: mid.base + 1 }],
    'a negative start first': [{ base: 1, hostStart: -5.5, etStart: 0, rate: 1 }, { base: 1, hostStart: 0, etStart: 5, rate: 1 }, ...table],
  };
  for (const [what, t] of Object.entries(ok)) {
    assert.ok(timeSorted(t), what);
    assert.equal((await load(withTimeTable(drift, t))).initStatus, 0, what);
  }
});

test('on random sorted tables the search gives what a scan of every entry gives, bit for bit', async () => {
  const rnd = prng(20261122);
  let compared = 0, tables = 0;
  for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 33, 64, 100, 255, 256, 257, 1000, 4096]) {
    for (let rep = 0; rep < (n > 300 ? 1 : 4); rep++) {
      // One to four time bases, with starts of several kinds: whole seconds,
      // microsecond readings, clustered a microsecond apart, negative, and large.
      const bases = [2, 3, 5, 65535].slice(0, 1 + Math.floor(rnd() * 4));
      const seen = new Set(), table = [];
      while (table.length < n) {
        const base = bases[Math.floor(rnd() * bases.length)];
        const kind = Math.floor(rnd() * 5);
        const sec = kind === 4 ? 4294000000 + Math.floor(rnd() * 900000) : Math.floor(rnd() * (kind === 2 ? 50 : 3e6)) - (kind === 3 ? 1000 : 0);
        const usec = kind === 0 ? 0 : Math.floor(rnd() * (kind === 2 ? 4 : 1e6));
        const hostStart = sec + usec * 1.0e-6;
        const key = `${base}/${hostStart}`;
        if (seen.has(key)) continue;
        seen.add(key);
        table.push({ base, hostStart, etStart: 1e8 + (rnd() - 0.5) * 1e7, rate: 1 + (rnd() - 0.5) * 1e-5 });
      }
      table.sort((a, b) => a.base - b.base || a.hostStart - b.hostStart);
      assert.ok(timeSorted(table));
      const api = await load(withTimeTable(drift, table, { fixCrc: false }), { skipCrc: true });
      assert.equal(api.initStatus, 0, `${n} pieces`);
      tables++;
      const ask = (base, sec, usec) => {
        if (sec < 0 || sec > 4294967295) return;
        const want = hostScan(table, base, sec, usec), got = api.host2et(base, sec, usec);
        assert.equal(got.status, want.status, `${n} pieces: host2et ${base} ${sec} ${usec}`);
        if (want.status === 0) assert.ok(sameBits(got.et, want.et), `${n} pieces: host2et ${base} ${sec} ${usec}: ${got.et} against ${want.et}`);
        compared++;
      };
      for (const t of table.length > 400 ? table.filter((_, i) => i % 7 === 0 || i < 3 || i > n - 4) : table) {
        const u = Math.round(t.hostStart * 1e6);
        for (const v of [u - 1, u, u + 1, u + 1e6]) ask(t.base, Math.floor(v / 1e6), ((v % 1e6) + 1e6) % 1e6);
        ask(t.base + 1, Math.floor(u / 1e6), ((u % 1e6) + 1e6) % 1e6);
        ask(t.base + 65536, Math.floor(u / 1e6), ((u % 1e6) + 1e6) % 1e6);
      }
      for (const base of [...bases, 0, 4, 9]) {
        ask(base, 0, 0); ask(base, 4294967295, 999999); ask(base, 10, 1000000);
        for (let i = 0; i < 20; i++) ask(base, Math.floor(rnd() * 4294967296), Math.floor(rnd() * 1e6));
      }
    }
  }
  console.log(`  ${tables} random sorted TIME tables of 0 to 4,096 pieces, ${compared} conversions identical to the scan`);
});

test('the largest TIME table the format allows (4,096 entries) loads and converts; one entry more is refused', async () => {
  const room = 4096;
  const table = Array.from({ length: room }, (_, i) => ({ base: 3, hostStart: 10 * i, etStart: 7e7 + 10 * i, rate: 1 }));
  const api = await load(withTimeTable(drift, table, { fixCrc: false }), { skipCrc: true });
  assert.equal(api.initStatus, 0);
  for (const i of [0, 1, 2, room >> 1, room - 2, room - 1]) {
    const r = api.host2et(3, 10 * i + 9, 999999);
    assert.equal(r.status, 0);
    assert.ok(sameBits(r.et, hostScan(table, 3, 10 * i + 9, 999999).et), `piece ${i}`);
  }
  // Unsorted at this size is still caught: the last two entries swapped.
  const t = table.slice(); [t[room - 2], t[room - 1]] = [t[room - 1], t[room - 2]];
  assert.equal((await load(withTimeTable(drift, t, { fixCrc: false }), { skipCrc: true })).initStatus, 4);
  table.push({ base: 3, hostStart: 10 * room, etStart: 0, rate: 1 });
  assert.equal((await load(withTimeTable(drift, table, { fixCrc: false }), { skipCrc: true })).initStatus, 4, 'over the cap of 4,096 entries');
});

test('the slicer writes TIME sorted whatever order the pieces are given in, and refuses two pieces that start together', async () => {
  const { sortTime } = await import('../tools/slicer.mjs');
  const given = [{ base: 5, hostStart: 3, etStart: 0, rate: 1 }, { base: 3, hostStart: 9, etStart: 0, rate: 1 }, { base: 3, hostStart: -2, etStart: 0, rate: 1 }, { base: 2, hostStart: 100, etStart: 0, rate: 1 }];
  const sorted = sortTime(given);
  assert.ok(timeSorted(sorted));
  assert.deepEqual(sorted.map((t) => [t.base, t.hostStart]), [[2, 100], [3, -2], [3, 9], [5, 3]]);
  assert.equal(given[0].base, 5, 'the input is left as given');
  assert.throws(() => sortTime([...given, { base: 3, hostStart: 9, etStart: 4, rate: 2 }]), /two pieces of time base 3 start at host second 9/);
  assert.equal(sortTime(Array.from({ length: 4096 }, (_, i) => ({ base: 3, hostStart: i, etStart: 0, rate: 1 }))).length, 4096);
  assert.throws(() => sortTime(Array.from({ length: 4097 }, (_, i) => ({ base: 3, hostStart: i, etStart: 0, rate: 1 }))), /at most 4,096/);
  assert.throws(() => sortTime([{ base: 1, hostStart: 0, etStart: 0, rate: 1 }, { base: 1, hostStart: -0, etStart: 0, rate: 1 }]), /two pieces/);
  assert.throws(() => sortTime([{ base: 70000, hostStart: 0, etStart: 0, rate: 1 }]), /not a 16-bit unsigned integer/);
  assert.throws(() => sortTime([{ base: 3, hostStart: NaN, etStart: 0, rate: 1 }]), /not finite/);
  // The committed many-piece blob was cut from a config that lists its bases out of order.
  const config = JSON.parse(readFileSync(resolve(root, 'test/blobs/sclk-many.json'), 'utf8'));
  assert.deepEqual(config.time.map((t) => t.base), [5, 3, 2, 2]);
  const written = readTimeTable(many);
  assert.ok(timeSorted(written));
  assert.deepEqual([...new Set(written.map((t) => t.base))], [2, 3, 5]);
});
