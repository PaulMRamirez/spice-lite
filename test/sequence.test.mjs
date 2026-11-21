// End to end: the demonstration sequence (examples/sequence/sun_watch.c) runs
// inside the SpaceWasm interpreter with stand-ins for the F Prime WasmSequencer
// host calls, and commands its image at the first check where the Sun is truly
// above the threshold according to full CSPICE.
//
// Needs build/sun_watch.wasm (scripts/build-sequence.sh) and the host harness
// (cargo build --release in bench/spacewasm-host); skipped with a note otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkModule } from '../scripts/check-wasm-mvp.mjs';
import { root } from './harness.mjs';

const wasm = resolve(root, 'build/sun_watch.wasm');
const host = resolve(root, 'bench/spacewasm-host/target/release/spice-lite-spacewasm-host');
const ready = existsSync(wasm) && existsSync(host);
const skip = !ready && 'build/sun_watch.wasm or the SpaceWasm host harness is not built';
const config = JSON.parse(readFileSync(resolve(root, 'test/blobs/sun-earth-moon.json'), 'utf8'));
const report = JSON.parse(readFileSync(resolve(root, 'test/blobs/sun-earth-moon.report.json'), 'utf8'));
const kernelDir = process.env.SPICE_LITE_KERNELS;
const haveKernels = kernelDir && config.kernels.every((k) => existsSync(resolve(kernelDir, k)));

const START = 14400; // spacecraft clock seconds; four hours into the blob's window, night at the site
const THRESHOLD_DEG = 10, PERIOD = 600;
const run = () => execFileSync(host, ['--sequence', '--module', wasm, '--start-seconds', String(START)], { encoding: 'utf8' })
  .trim().split('\n').map((l) => JSON.parse(l));

test('the sequence module is strict WebAssembly 1.0 and imports only the sequencer host calls', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(wasm));
  checkModule(bytes);
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module);
  assert.ok(imports.length > 0 && imports.every((i) => i.module === 'fprime_v1'), JSON.stringify(imports));
  assert.deepEqual(imports.map((i) => i.name).sort(), ['cmd', 'event', 'exit', 'rsleep', 'time']);
});

test('it waits through the night, then images once, in one page, a few slices per decision', { skip }, () => {
  const lines = run();
  const load = lines.find((l) => l.kind === 'load'), exit = lines.find((l) => l.kind === 'exit');
  const commands = lines.filter((l) => l.kind === 'command'), sleeps = lines.filter((l) => l.kind === 'sleep');
  assert.equal(load.guest_memory_bytes, 65536, 'one page');
  assert.equal(exit.code, 0);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].bytes, '00001001');
  assert.ok(sleeps.length > 10, 'it had to wait');
  assert.ok(sleeps.every((s) => s.sleep_seconds === PERIOD));
  // The first cycle includes lite_init with the checksum; every later decision is small.
  const later = sleeps.slice(1).map((s) => s.instructions_since_sleep);
  const worst = Math.max(...later, exit.instructions_since_sleep);
  assert.ok(worst < 10000, `a decision took ${worst} instructions`);
  console.log(`  ${sleeps.length} checks before imaging at clock ${exit.host_seconds} s; first cycle ${sleeps[0].instructions_since_sleep} instructions (start-up), later decisions at most ${worst}`);
});

test('the image is commanded at the first check where CSPICE puts the Sun above the threshold', { skip: skip || (!haveKernels && 'SPICE_LITE_KERNELS is not set or lacks the kernels') }, async () => {
  const lines = run();
  const fired = lines.find((l) => l.kind === 'command').host_seconds;
  const { createSpiceEngine } = await import('cspice-wasm');
  const spice = await createSpiceEngine();
  for (const k of config.kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
  const site = report.sites.find((s) => s.id === 2), frame = config.orient.find((o) => o.body === site.body).frame;
  const piece = report.time[0];
  const elevationDeg = async (hostSeconds) => {
    const et = piece.etStart + piece.rate * (hostSeconds - piece.hostStart);
    const s = await spice.spkezr('10', et, 'J2000', 'NONE', String(site.body));
    const m = await spice.pxform('J2000', frame, et);
    const r = [s.position.x, s.position.y, s.position.z];
    const bf = [0, 1, 2].map((k) => m[3 * k] * r[0] + m[3 * k + 1] * r[1] + m[3 * k + 2] * r[2]);
    const d = bf.map((v, k) => v - site.position[k]), rs = Math.hypot(...site.position);
    return (Math.asin((d[0] * site.position[0] + d[1] * site.position[1] + d[2] * site.position[2]) / (rs * Math.hypot(...d))) * 180) / Math.PI;
  };
  let expected = null;
  for (let t = START; t < START + 200 * PERIOD; t += PERIOD) {
    if ((await elevationDeg(t)) >= THRESHOLD_DEG) { expected = t; break; }
  }
  assert.equal(fired, expected, 'commanded at the first qualifying check');
  // Every elevation the sequence reported agrees with CSPICE to the two decimals it prints.
  for (const e of lines.filter((l) => l.kind === 'event')) {
    const reported = Number(e.text.match(/(-?\d+\.\d\d)$/)[1]);
    assert.ok(Math.abs(reported - (await elevationDeg(e.host_seconds))) <= 0.0051, `${e.text} at ${e.host_seconds}`);
  }
});
