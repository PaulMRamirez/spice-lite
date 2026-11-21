// The flight-shaped case: the shipped module, which declares a single 64 KiB page,
// holds itself and the Sun, Earth, Moon blob without growing memory, and answers
// within the blob's declared bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { load, prng, root } from './harness.mjs';

const name = 'sun-earth-moon';
const config = JSON.parse(readFileSync(resolve(root, `test/blobs/${name}.json`), 'utf8'));
const report = JSON.parse(readFileSync(resolve(root, `test/blobs/${name}.report.json`), 'utf8'));
const blob = new Uint8Array(readFileSync(resolve(root, `test/blobs/${name}.slb`)));
const kernelDir = process.env.SPICE_LITE_KERNELS;
const have = kernelDir && config.kernels.every((k) => existsSync(resolve(kernelDir, k)));

test('library and blob fit in the one page the module declares', async () => {
  const api = await load(blob);
  assert.equal(api.initStatus, 0);
  assert.equal(api.memoryPages(), 1, 'memory was not grown');
  const used = ((api.exports.__heap_base.value + 7) & ~7) + blob.length;
  assert.ok(used < 32768, `module data, stack, and blob end at byte ${used}`);
  console.log(`  blob ${blob.length} bytes; module data, stack, and blob end at byte ${used} of 65,536`);
});

test('its answers match CSPICE within the declared bounds', { skip: !have && 'SPICE_LITE_KERNELS is not set or lacks the kernels' }, async () => {
  const { createSpiceEngine } = await import('cspice-wasm');
  const spice = await createSpiceEngine();
  for (const k of config.kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
  const api = await load(blob);
  const parentOf = new Map(config.bodies.map((b) => [b.id, b.parent]));
  const posErr = new Map(report.ephem.map((s) => [s.target, s.maxPosErr]));
  const velErr = new Map(report.ephem.map((s) => [s.target, s.maxVelErr]));
  const chain = (errs, a, b) => { let s = 0; for (const start of [a, b]) for (let id = start; parentOf.get(id) != null; id = parentOf.get(id)) s += errs.get(id); return 1.5 * s; };
  const bound = (a, b) => chain(posErr, a, b) + 1e-9;
  const [w0, w1] = report.windowEt;
  const rnd = prng(31);
  const ids = [0, 3, 10, 301, 399], corr = ['NONE', 'LT', 'LT+S'];
  for (let i = 0; i < 200; i++) {
    const t = ids[Math.floor(rnd() * 5)], o = ids[Math.floor(rnd() * 5)];
    if (t === o) continue;
    const et = w0 + 2000 + (w1 - w0 - 4000) * rnd();
    const got = api.state(t, o, et, i % 3);
    assert.equal(got.status, 0);
    const want = await spice.spkezr(String(t), et, 'J2000', corr[i % 3], String(o));
    const range = Math.hypot(want.position.x, want.position.y, want.position.z);
    const d = Math.hypot(got.state[0] - want.position.x, got.state[1] - want.position.y, got.state[2] - want.position.z);
    assert.ok(d <= bound(t, o) + 1e-12 * range + (i % 3 === 2 ? (range * chain(velErr, o, 0)) / 299792.458 : 0), `${t} wrt ${o} ${corr[i % 3]}: off by ${d} km`);
  }
  for (const o of config.orient) {
    const maxErr = report.orient.find((s) => s.body === o.body).maxErr;
    for (let i = 0; i < 40; i++) {
      const et = w0 + 2 + (w1 - w0 - 4) * rnd();
      const got = api.orient(o.body, et), want = await spice.pxform('J2000', o.frame, et);
      for (let k = 0; k < 9; k++) assert.ok(Math.abs(got.rot[k] - want[k]) <= 1.5 * maxErr + 1e-12);
    }
  }
  const view = api.siteView(1, 10, w0 + 5 * 86400, 0);
  assert.equal(view.status, 0);
  assert.ok(view.range > 1.4e8 && view.range < 1.6e8);
});
