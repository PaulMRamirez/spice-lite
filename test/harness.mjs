// Loads the WebAssembly build of spice-lite and answers the same text queries
// the native driver answers, so outputs compare byte for byte across hosts.
// Doubles travel as 16 hexadecimal digits of their bit pattern.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '..');
export const wasmPath = resolve(root, 'build/spice_lite.wasm');

const scratchF64 = new Float64Array(1);
const scratchU64 = new BigUint64Array(scratchF64.buffer);
export const toHex = (d) => { scratchF64[0] = d; return scratchU64[0].toString(16).padStart(16, '0'); };
export const fromHex = (h) => { scratchU64[0] = BigInt('0x' + h); return scratchF64[0]; };

export async function load(blobBytes, { skipCrc = false } = {}) {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error('the module has imports');
  const { exports: x } = await WebAssembly.instantiate(module, {});
  const base = (x.__heap_base.value + 7) & ~7;
  const scratch = 256; // output area after the blob
  const need = base + blobBytes.length + 8 + scratch;
  const pages = Math.ceil(need / 65536) - x.memory.buffer.byteLength / 65536;
  if (pages > 0) x.memory.grow(pages);
  new Uint8Array(x.memory.buffer).set(blobBytes, base);
  const out = (base + blobBytes.length + 7) & ~7;
  const view = () => new DataView(x.memory.buffer);
  const f64 = (i) => view().getFloat64(out + 8 * i, true);
  const putF64 = (i, v) => view().setFloat64(out + 8 * i, v, true);
  const i32 = (off) => view().getInt32(out + off, true);
  const initStatus = x.lite_init(base, blobBytes.length, skipCrc ? 1 : 0);

  const api = {
    exports: x,
    initStatus,
    memoryPages: () => x.memory.buffer.byteLength / 65536,
    host2et(base_, sec, usec) {
      const st = x.lite_host2et(base_, sec, usec, out);
      return { status: st, et: f64(0) };
    },
    fwtime(bytes) {
      new Uint8Array(x.memory.buffer).set(bytes, out + 64);
      const st = x.lite_fwtime2et(out + 64, bytes.length, out);
      return { status: st, et: f64(0) };
    },
    state(target, observer, et, corr) {
      const st = x.lite_state(target, observer, et, corr, out, out + 48, out + 56);
      return { status: st, state: [0, 1, 2, 3, 4, 5].map(f64), lt: f64(6), source: i32(56) };
    },
    setState(body, center, et, s, maxAge) {
      s.forEach((v, i) => putF64(i, v));
      return x.lite_set_state(body, center, et, out, maxAge);
    },
    clearState: () => x.lite_clear_state(),
    gap(et) {
      const st = x.lite_state_gap(et, out, out + 8);
      return { status: st, dpos: f64(0), dvel: f64(1) };
    },
    orient(body, et) {
      const st = x.lite_orient(body, et, out);
      return { status: st, rot: [0, 1, 2, 3, 4, 5, 6, 7, 8].map(f64) };
    },
    siteView(site, target, et, corr) {
      const st = x.lite_site_view(site, target, et, corr, out, out + 8, out + 16);
      return { status: st, az: f64(0), el: f64(1), range: f64(2) };
    },
    subPoint(body, observer, et) {
      const st = x.lite_sub_point(body, observer, et, out, out + 8, out + 16);
      return { status: st, lon: f64(0), lat: f64(1), alt: f64(2) };
    },
    occulted(target, by, observer, et) {
      const st = x.lite_occulted(target, by, observer, et, out);
      return { status: st, code: i32(0) };
    },
    // One query line in, one result line out; the native driver's format.
    run(line) {
      const t = line.trim().split(/\s+/);
      const hx = (vals) => vals.map((v) => ' ' + toHex(v)).join('');
      switch (t[0]) {
        case 'host2et': { const r = api.host2et(+t[1], +t[2], +t[3]); return r.status + (r.status === 0 ? hx([r.et]) : ''); }
        case 'fwtime': { const b = Uint8Array.from(t[1].match(/../g).map((h) => parseInt(h, 16))); const r = api.fwtime(b); return r.status + (r.status === 0 ? hx([r.et]) : ''); }
        case 'state': { const r = api.state(+t[1], +t[2], fromHex(t[3]), +t[4]); return r.status + (r.status === 0 ? hx([...r.state, r.lt]) + ' i' + r.source : ''); }
        case 'setstate': return String(api.setState(+t[1], +t[2], fromHex(t[3]), t.slice(4, 10).map(fromHex), fromHex(t[10])));
        case 'clearstate': return String(api.clearState());
        case 'gap': { const r = api.gap(fromHex(t[1])); return r.status + (r.status === 0 ? hx([r.dpos, r.dvel]) : ''); }
        case 'orient': { const r = api.orient(+t[1], fromHex(t[2])); return r.status + (r.status === 0 ? hx(r.rot) : ''); }
        case 'siteview': { const r = api.siteView(+t[1], +t[2], fromHex(t[3]), +t[4]); return r.status + (r.status === 0 ? hx([r.az, r.el, r.range]) : ''); }
        case 'subpoint': { const r = api.subPoint(+t[1], +t[2], fromHex(t[3])); return r.status + (r.status === 0 ? hx([r.lon, r.lat, r.alt]) : ''); }
        case 'occulted': { const r = api.occulted(+t[1], +t[2], +t[3], fromHex(t[4])); return r.status + (r.status === 0 ? ' i' + r.code : ''); }
        default: return '?';
      }
    },
  };
  return api;
}

export function runAll(api, queryText) {
  const lines = ['init ' + api.initStatus];
  for (const q of queryText.split('\n')) {
    if (!q.trim() || q.startsWith('#')) continue;
    lines.push(api.run(q));
  }
  return lines.join('\n') + '\n';
}

// Small deterministic generator so query sets are reproducible.
export function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
