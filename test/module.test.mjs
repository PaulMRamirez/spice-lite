// The shape of the WebAssembly module: strict Wasm 1.0, no imports, one page,
// and within the size budget of the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkModule } from '../scripts/check-wasm-mvp.mjs';
import { wasmPath } from './harness.mjs';

const bytes = new Uint8Array(readFileSync(wasmPath));

test('the module is strict WebAssembly 1.0 with no imports', async () => {
  const stats = checkModule(bytes); // throws on any opcode or section outside Wasm 1.0
  assert.equal(stats.imports.length, 0);
  const module = await WebAssembly.compile(bytes);
  assert.equal(WebAssembly.Module.imports(module).length, 0);
});

test('the module fits the spec budgets', async () => {
  assert.ok(bytes.length < 32 * 1024, `module is ${bytes.length} bytes; the budget is 32 KiB`);
  const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {});
  assert.equal(exports.memory.buffer.byteLength, 65536, 'declares exactly one page');
  for (const name of ['lite_init', 'lite_host2et', 'lite_fwtime2et', 'lite_state', 'lite_set_state', 'lite_clear_state', 'lite_state_gap', 'lite_orient', 'lite_site_view', 'lite_sub_point', 'lite_occulted', 'lite_occulted_shapes']) {
    assert.equal(typeof exports[name], 'function', name);
  }
});
