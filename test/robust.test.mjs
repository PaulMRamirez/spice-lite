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
