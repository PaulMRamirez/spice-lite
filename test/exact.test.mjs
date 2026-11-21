// Tier A, exactness: the same blob and queries give bit-identical answers in
// the WebAssembly build and the native build, and both match the committed
// vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { load, runAll, root } from './harness.mjs';

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
