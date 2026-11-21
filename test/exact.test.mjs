// Tier A, exactness: the same blob and queries give bit-identical answers in
// the WebAssembly build and the native build, and both match the committed
// vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { load, runAll, toHex, root } from './harness.mjs';

const blobPath = resolve(root, 'test/blobs/cassini-soi.slb');
const blob = new Uint8Array(readFileSync(blobPath));
const queries = readFileSync(resolve(root, 'test/vectors/cassini-soi.queries'), 'utf8');
const expected = readFileSync(resolve(root, 'test/vectors/cassini-soi.expected'), 'utf8');

test('the WebAssembly build reproduces the committed vectors bit for bit', async () => {
  assert.equal(runAll(await load(blob), queries), expected);
});

test('the native build reproduces the same bits', { skip: !existsSync(resolve(root, 'build/driver')) && 'build/driver not built' }, () => {
  const out = execFileSync(resolve(root, 'build/driver'), ['run', blobPath], { input: queries, encoding: 'utf8' });
  assert.equal(out, expected);
});

test('skipping the checksum does not change any answer', async () => {
  assert.equal(runAll(await load(blob, { skipCrc: true }), queries), expected);
});

// Time conversion on TIME sections with many pieces: sclk-drift (6 pieces, two
// partitions) and sclk-many (203 clock pieces and three of other bases). The
// vectors were confirmed against the library as it was when lite_host2et
// scanned every entry, so they hold the binary search to the same bits.
for (const name of ['sclk-drift', 'sclk-many']) {
  const path = resolve(root, `test/blobs/${name}.slb`);
  const timeBlob = new Uint8Array(readFileSync(path));
  const timeQueries = readFileSync(resolve(root, `test/vectors/${name}.queries`), 'utf8');
  const timeExpected = readFileSync(resolve(root, `test/vectors/${name}.expected`), 'utf8');

  test(`${name}: the WebAssembly build reproduces the time vectors bit for bit`, async () => {
    assert.equal(runAll(await load(timeBlob), timeQueries), timeExpected);
  });

  test(`${name}: the native build reproduces the same bits`, { skip: !existsSync(resolve(root, 'build/driver')) && 'build/driver not built' }, () => {
    const out = execFileSync(resolve(root, 'build/driver'), ['run', path], { input: timeQueries, encoding: 'utf8' });
    assert.equal(out, timeExpected);
  });

  test(`${name}: every vector is what a scan of every TIME entry gives`, async () => {
    // The reference scan in JavaScript, independent of the library: the piece
    // of the reading's base with the latest host_start not after it.
    const { readTimeTable, hostScan } = await import('./time-table.mjs');
    const table = readTimeTable(timeBlob);
    const want = timeExpected.trim().split('\n').slice(1);
    const asked = timeQueries.split('\n').filter((q) => q.trim() && !q.startsWith('#'));
    assert.equal(asked.length, want.length);
    let n = 0;
    asked.forEach((q, i) => {
      const t = q.split(/\s+/);
      if (t[0] !== 'host2et') return;
      const r = hostScan(table, +t[1], +t[2], +t[3]);
      assert.equal(want[i], r.status === 0 ? `0 ${toHex(r.et)}` : String(r.status), q);
      n++;
    });
    assert.ok(n > 100, `${n} conversions compared`);
  });
}
