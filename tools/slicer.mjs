// Reference slicer for the spice-lite blob format (SPEC.md, draft 0.1).
//
// Reads full SPICE kernels through cspice-wasm, fits compact segments over a
// mission window, measures each fit against CSPICE on a denser grid, and writes
// one blob. This is ground software: it is allowed to be slow and to depend on
// the full toolkit. Usage:
//
//   node tools/slicer.mjs <config.json> <out.slb> [report.json]
//
// Kernel names in the config are resolved against the directory named by the
// SPICE_LITE_KERNELS environment variable, or a kernels/ directory beside the
// config file. Kernels are never committed to this repository. A kernel name
// that starts with ./ or ../ is instead a path relative to the config file,
// which is how small synthetic test kernels kept in this repository are named.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, basename } from 'node:path';
import { createSpiceEngine } from 'cspice-wasm';
import { sclkTimePieces, unixTimePieces } from './sclk-time.mjs';
import { sliceOrbit } from './orbit-model.mjs';
import { findBreaks, endingBefore } from './find-breaks.mjs';

export const SLICER_VERSION = '0.2.0';

// ---- Chebyshev helpers (the same recurrences the flight library uses) -------

export function chebNodes(n) {
  const x = [];
  for (let j = 0; j <= n; j++) x.push(Math.cos((Math.PI * (j + 0.5)) / (n + 1)));
  return x;
}

// Coefficients of the degree-n interpolant through samples taken at chebNodes(n).
export function chebFit(samples, n) {
  const c = new Array(n + 1).fill(0);
  for (let k = 0; k <= n; k++) {
    let s = 0;
    for (let j = 0; j <= n; j++) s += samples[j] * Math.cos((k * Math.PI * (j + 0.5)) / (n + 1));
    c[k] = (2 * s) / (n + 1);
  }
  c[0] /= 2;
  return c;
}

export function chebEval(c, x) {
  const n = c.length - 1;
  const x2 = 2 * x;
  let w0 = 0, w1 = 0, w2 = 0, d0 = 0, d1 = 0, d2 = 0;
  for (let j = n; j >= 1; j--) {
    w2 = w1; w1 = w0; w0 = c[j] + (x2 * w1 - w2);
    d2 = d1; d1 = d0; d0 = 2 * w1 + (x2 * d1 - d2);
  }
  return { value: c[0] + (x * w0 - w1), deriv: w0 + (x * d0 - d1) };
}

const wrapPi = (a) => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
};

// ---- CRC-32 (IEEE 802.3) ----------------------------------------------------

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

// ---- blob assembly ----------------------------------------------------------

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  align8() { const pad = (8 - (this.length % 8)) % 8; if (pad) this.bytes(new Uint8Array(pad)); }
  bytes(u8) { this.parts.push(u8); this.length += u8.length; }
  concat() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

const f64s = (arr) => new Uint8Array(new Float64Array(arr).buffer.slice(0));

// TIME entries in the order the format requires (SPEC.md, "TIME"): ascending by
// key, then by host_start, with no two pieces of one key starting at the same
// reading. The key is the time base, with the context above it when any piece
// names one (the blob then selects by context; pieces that name none have
// context 0). The library refuses any other order, because it finds a piece by
// binary search. Returns a sorted copy; throws on a piece it cannot place.
export const timeKey = (t) => t.base + 65536 * (t.context ?? 0);
export function sortTime(time) {
  for (const t of time) {
    if (!Number.isInteger(t.base) || t.base < 0 || t.base > 65535) throw new Error(`TIME: time base ${t.base} is not a 16-bit unsigned integer`);
    if (t.context !== undefined && (!Number.isInteger(t.context) || t.context < 0 || t.context > 255)) throw new Error(`TIME: context ${t.context} of time base ${t.base} is not an 8-bit unsigned integer`);
    if (![t.hostStart, t.etStart, t.rate].every(Number.isFinite)) throw new Error(`TIME: a piece of time base ${t.base} holds a number that is not finite`);
    if (t.maxErr !== undefined && !(t.maxErr >= 0 && Number.isFinite(t.maxErr))) throw new Error(`TIME: a piece of time base ${t.base} has an error bound that is not a number at or above zero`);
  }
  if (time.length > 4096) throw new Error(`TIME: ${time.length} pieces; a blob holds at most 4,096 (loosen a clock's tolerance or shorten the window)`);
  const sorted = [...time].sort((a, b) => timeKey(a) - timeKey(b) || a.hostStart - b.hostStart);
  for (let i = 1; i < sorted.length; i++) {
    if (timeKey(sorted[i]) === timeKey(sorted[i - 1]) && sorted[i].hostStart === sorted[i - 1].hostStart) {
      throw new Error(`TIME: two pieces of time base ${sorted[i].base}${sorted[i].context === undefined ? '' : `, context ${sorted[i].context},`} start at host second ${sorted[i].hostStart}; a reading there would have two answers`);
    }
  }
  return sorted;
}

// The smallest 32-bit float not below x, for an error bound that must not be
// rounded down when it is stored.
export function f32Up(x) {
  const f = Math.fround(x);
  if (f >= x) return f;
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, f);
  v.setUint32(0, v.getUint32(0) + 1);
  return v.getFloat32(0);
}

function buildBlob(model) {
  const { bodies, ephem, orient, sites, prov, created } = model;
  const time = sortTime(model.time);
  // Header flag bit 2: pieces are selected by context too. Bit 3: some piece
  // is a gap. A library from before either refuses a blob that sets it.
  const flags = model.flags | (time.some((t) => t.context !== undefined) ? 4 : 0) | (time.some((t) => t.gap) ? 8 : 0);
  const sections = [];

  const mk = (type, required, entries, entrySize, fill, tail = []) => {
    const table = new Uint8Array(entries.length * entrySize);
    const view = new DataView(table.buffer);
    sections.push({ type, required, count: entries.length, table, view, entries, entrySize, fill, tail });
  };

  if (time.length) {
    mk(1, false, time, 32, (v, o, t) => {
      v.setUint16(o, t.base, true);
      v.setUint8(o + 2, t.context ?? 0);
      v.setUint8(o + 3, t.gap ? 1 : 0);
      v.setFloat32(o + 4, t.maxErr === undefined ? 0 : f32Up(t.maxErr), true);
      v.setFloat64(o + 8, t.hostStart, true);
      v.setFloat64(o + 16, t.etStart, true);
      v.setFloat64(o + 24, t.rate, true);
    });
  }
  mk(2, true, bodies, 32, (v, o, b) => {
    v.setInt32(o, b.id, true);
    v.setInt16(o + 4, b.parentIndex, true);
    v.setUint16(o + 6, (b.radii ? 1 : 0) | (b.spacecraft ? 2 : 0), true);
    const r = b.radii ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) v.setFloat64(o + 8 + 8 * i, r[i], true);
  });
  mk(3, true, ephem, 48, (v, o, s, dataOffset) => {
    v.setInt32(o, s.target, true);
    v.setInt32(o + 4, s.center, true);
    v.setUint8(o + 8, s.kind);
    v.setUint8(o + 9, s.source);
    v.setUint8(o + 10, s.degree);
    v.setUint32(o + 12, s.recordCount, true);
    v.setFloat64(o + 16, s.tStart, true);
    v.setFloat64(o + 24, s.interval, true);
    v.setUint32(o + 32, dataOffset, true);
    v.setFloat32(o + 36, s.maxPosErr, true);
    v.setFloat32(o + 40, s.maxVelErr, true);
  }, ephem.map((s) => s.records));
  if (orient.length) {
    mk(4, false, orient, 64, (v, o, s, dataOffset) => {
      v.setInt32(o, s.body, true);
      v.setUint8(o + 4, 1);
      v.setUint8(o + 5, s.degree);
      v.setUint32(o + 8, s.recordCount, true);
      v.setUint32(o + 12, dataOffset, true);
      v.setFloat64(o + 16, s.tStart, true);
      v.setFloat64(o + 24, s.interval, true);
      v.setFloat64(o + 32, s.w0, true);
      v.setFloat64(o + 40, s.wRate, true);
      v.setFloat32(o + 48, s.maxErr, true);
    }, orient.map((s) => s.records));
  }
  if (sites.length) {
    mk(5, false, sites, 32, (v, o, s) => {
      v.setInt32(o, s.id, true);
      v.setInt32(o + 4, s.body, true);
      for (let i = 0; i < 3; i++) v.setFloat64(o + 8 + 8 * i, s.position[i], true);
    });
  }
  const provBytes = (() => {
    let text = JSON.stringify(prov);
    while (new TextEncoder().encode(text).length % 8 !== 0) text += ' ';
    return new TextEncoder().encode(text);
  })();

  const dirCount = sections.length + 1;
  const w = new Writer();
  w.bytes(new Uint8Array(64 + 16 * dirCount));
  const dir = [];
  for (const s of sections) {
    w.align8();
    const start = w.length;
    let cursor = start + s.table.length;
    cursor += (8 - (cursor % 8)) % 8;
    const offsets = [];
    for (const rec of s.tail) { offsets.push(cursor); cursor += rec.length; cursor += (8 - (cursor % 8)) % 8; }
    s.entries.forEach((e, i) => s.fill(s.view, i * s.entrySize, e, offsets[i]));
    w.bytes(s.table);
    for (const rec of s.tail) { w.align8(); w.bytes(rec); }
    w.align8();
    dir.push({ type: s.type, flags: s.required ? 1 : 0, offset: start, length: w.length - start, count: s.count });
  }
  w.align8();
  dir.push({ type: 6, flags: 0, offset: w.length, length: provBytes.length, count: 0 });
  w.bytes(provBytes);
  w.align8();

  const blob = w.concat();
  const v = new DataView(blob.buffer);
  blob.set([0x53, 0x4c, 0x42, 0x31], 0); // "SLB1"
  v.setUint16(4, 0, true);
  v.setUint16(6, 1, true);
  v.setUint32(8, blob.length, true);
  v.setUint32(16, flags, true);
  v.setUint16(20, dirCount, true);
  v.setFloat64(24, model.coverage[0], true);
  v.setFloat64(32, model.coverage[1], true);
  v.setFloat64(40, created, true);
  dir.forEach((d, i) => {
    const o = 64 + 16 * i;
    v.setUint16(o, d.type, true);
    v.setUint16(o + 2, d.flags, true);
    v.setUint32(o + 4, d.offset, true);
    v.setUint32(o + 8, d.length, true);
    v.setUint32(o + 12, d.count, true);
  });
  const id = createHash('sha256').update(blob.subarray(64)).digest();
  blob.set(id.subarray(0, 8), 48);
  return setChecksum(blob, model.checksum ?? 'crc32');
}

// ---- Fletcher-32 ------------------------------------------------------------

// The other checksum a blob may carry (header flag bit 4): two sums modulo
// 65535 over 16-bit little-endian words, starting at zero, the second sum in
// the high half; an odd last byte is a word with a zero high byte.
export function fletcher32(bytes) {
  let a = 0, b = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    a = (a + bytes[i] + 256 * (bytes[i + 1] ?? 0)) % 65535;
    b = (b + a) % 65535;
  }
  return (b * 65536 + a) >>> 0;
}

// Rewrites a finished blob's checksum as the kind named ('crc32' or
// 'fletcher32'), setting or clearing header flag bit 4 to match. Nothing else
// changes, the blob identifier included: it covers bytes 64 to the end.
export function setChecksum(blob, kind) {
  if (kind !== 'crc32' && kind !== 'fletcher32') throw new Error(`checksum: "${kind}" is neither "crc32" nor "fletcher32"`);
  const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  v.setUint32(16, (v.getUint32(16, true) & ~16) | (kind === 'fletcher32' ? 16 : 0), true);
  v.setUint32(12, (kind === 'fletcher32' ? fletcher32 : crc32)(blob.subarray(16)), true);
  return blob;
}

// ---- slicing ----------------------------------------------------------------

const vec = (p) => [p.x, p.y, p.z];

export async function sliceEphem(spice, spec, window, parentId) {
  const [t0, t1] = window;
  const dt = spec.interval;
  const n = spec.degree;
  const count = Math.ceil((t1 - t0) / dt - 1e-9);
  const nodes = chebNodes(n);
  const records = new Float64Array(count * 3 * (n + 1));
  let maxPos = 0, maxVel = 0;
  const state = async (t) => {
    const s = await spice.spkezr(String(spec.id), t, 'J2000', 'NONE', String(parentId));
    return [...vec(s.position), ...vec(s.velocity)];
  };
  for (let k = 0; k < count; k++) {
    const tk = t0 + k * dt;
    const samples = [];
    for (const x of nodes) samples.push(await state(tk + ((x + 1) * dt) / 2));
    const coeffs = [0, 1, 2].map((a) => chebFit(samples.map((s) => s[a]), n));
    coeffs.forEach((c, a) => records.set(c, k * 3 * (n + 1) + a * (n + 1)));
    // Measure the fit between the nodes and at both record edges; the derivative
    // of a Chebyshev fit is at its worst at the edges, so they must be sampled.
    const checks = spec.checks ?? 24;
    for (let j = 0; j <= checks; j++) {
      const x = -1 + (2 * j) / checks;
      const truth = await state(tk + ((x + 1) * dt) / 2);
      let dp = 0, dv = 0;
      for (let a = 0; a < 3; a++) {
        const e = chebEval(coeffs[a], x);
        dp += (e.value - truth[a]) ** 2;
        dv += ((e.deriv * 2) / dt - truth[a + 3]) ** 2;
      }
      maxPos = Math.max(maxPos, Math.sqrt(dp));
      maxVel = Math.max(maxVel, Math.sqrt(dv));
    }
  }
  return {
    target: spec.id, center: parentId, kind: 1, source: spec.predicted ? 1 : 0, degree: n,
    recordCount: count, tStart: t0, interval: dt, maxPosErr: maxPos, maxVelErr: maxVel,
    records: f64s(records),
  };
}

// Right ascension and declination of the pole, and the prime meridian angle,
// from the J2000 to body-fixed rotation.
function poleAngles(m) {
  return {
    ra: Math.atan2(m[7], m[6]),
    dec: Math.asin(Math.max(-1, Math.min(1, m[8]))),
    w: Math.atan2(m[2], m[5]),
  };
}

async function sliceOrient(spice, spec, window) {
  const [t0, t1] = window;
  const dt = spec.interval;
  const n = spec.degree;
  const count = Math.ceil((t1 - t0) / dt - 1e-9);
  const span = count * dt;
  const angles = async (t) => poleAngles(await spice.pxform('J2000', spec.frame, t));
  const a0 = await angles(t0);
  const probe = 10;
  const rate0 = wrapPi((await angles(t0 + probe)).w - a0.w) / probe;
  // Walk the span in steps short enough that the residual never wraps, then
  // fold the end residual into the rate so the fitted part stays small.
  let resid = 0;
  const steps = Math.max(64, Math.ceil(span / 3600));
  for (let i = 1; i <= steps; i++) {
    const t = t0 + (span * i) / steps;
    const r = wrapPi((await angles(t)).w - a0.w - rate0 * (t - t0) - resid);
    resid += r;
  }
  const wRate = rate0 + resid / span;
  const series = async (t) => {
    const a = await angles(t);
    return [
      a0.ra + wrapPi(a.ra - a0.ra),
      a.dec,
      wrapPi(a.w - a0.w - wRate * (t - t0)),
    ];
  };
  const nodes = chebNodes(n);
  const records = new Float64Array(count * 3 * (n + 1));
  let maxErr = 0;
  for (let k = 0; k < count; k++) {
    const tk = t0 + k * dt;
    const samples = [];
    for (const x of nodes) samples.push(await series(tk + ((x + 1) * dt) / 2));
    const coeffs = [0, 1, 2].map((a) => chebFit(samples.map((s) => s[a]), n));
    coeffs.forEach((c, a) => records.set(c, k * 3 * (n + 1) + a * (n + 1)));
    const checks = spec.checks ?? 24;
    for (let j = 0; j <= checks; j++) {
      const x = -1 + (2 * j) / checks;
      const truth = await series(tk + ((x + 1) * dt) / 2);
      let e = 0;
      for (let a = 0; a < 3; a++) e += (chebEval(coeffs[a], x).value - truth[a]) ** 2;
      maxErr = Math.max(maxErr, Math.sqrt(e));
    }
  }
  return {
    body: spec.body, degree: n, recordCount: count, tStart: t0, interval: dt,
    w0: a0.w, wRate, maxErr, records: f64s(records),
  };
}

export async function slice(config, kernelDir, configDir = kernelDir) {
  const spice = await createSpiceEngine();
  const kernels = [];
  for (const k of config.kernels) {
    const bytes = new Uint8Array(readFileSync(resolve(/^\.\.?\//.test(k) ? configDir : kernelDir, k)));
    await spice.furnsh(basename(k), bytes);
    kernels.push({ name: basename(k), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const et = async (utc) => spice.str2et(utc);
  const window = [await et(config.window.start), await et(config.window.stop)];
  // Synthetic test trajectories (tools/synth-orbiter.mjs): integrated here, written
  // to an SPK in the engine, and from then on read through CSPICE like any kernel.
  for (const s of config.synthetic ?? []) kernels.push(await (await import('./synth-orbiter.mjs')).furnishSynthetic(spice, s, window));

  const bodies = [...config.bodies].sort((a, b) => a.id - b.id);
  const indexOf = new Map(bodies.map((b, i) => [b.id, i]));
  for (const b of bodies) {
    b.parentIndex = b.parent === null || b.parent === undefined ? -1 : indexOf.get(b.parent);
    if (b.parentIndex === undefined) throw new Error(`body ${b.id}: parent ${b.parent} is not in the body list`);
    if (b.radiiFrom) {
      try { b.radii = await spice.bodvrd(b.radiiFrom, 'RADII'); } catch { b.radii = null; }
    }
  }
  const roots = bodies.filter((b) => b.parentIndex === -1);
  if (roots.length !== 1) throw new Error('the body list needs exactly one root');

  const ephem = [];
  let coverage = [...window];
  const breaksFound = [];
  for (const b of bodies) {
    if (b.parentIndex === -1 || b.noSegment) continue;
    const w = b.window ? [await et(b.window.start), await et(b.window.stop)] : window;
    const cut = (spec, span, engine = spice) => (b.model === 'orbit' ? sliceOrbit(engine, spec, span, b.parent) : sliceEphem(engine, spec, span, b.parent));
    // "findBreaks": look for burns and seams in the kernel and break there
    // too (tools/find-breaks.mjs). true takes the defaults; an object
    // overrides stepSeconds, positionKm, velocityKmS, or mergeSeconds.
    let found = [];
    if (b.findBreaks) {
      found = await findBreaks(spice, b.id, b.parent, w, b.findBreaks === true ? {} : b.findBreaks);
      breaksFound.push({ target: b.id, breaks: found });
    }
    if (!b.breaks?.length && !found.length) {
      const seg = await cut(b, w);
      ephem.push(seg);
      coverage = [Math.max(coverage[0], seg.tStart), Math.min(coverage[1], seg.tStart + seg.recordCount * seg.interval)];
      continue;
    }
    // "breaks": times no record may span (the start and end of a maneuver, a
    // seam between orbit solutions). The body gets one segment per stretch
    // between them, each with its own grid: the record length nearest the one
    // asked for that divides the stretch, nudged up by rounding errors only,
    // so that neighboring segments meet with no gap a query could fall into.
    const times = [];
    for (const utc of b.breaks ?? []) times.push(await et(utc));
    let inside = [...new Set(times)].filter((t) => t > w[0] && t < w[1]);
    if (inside.length !== times.length) throw new Error(`body ${b.id}: every break must be a distinct time inside the body's window`);
    inside = [...new Set([...inside, ...found.map((f) => f.et)])].sort((x, y) => x - y);
    const edges = [w[0], ...inside, w[1]];
    let first = Infinity, last = -Infinity;
    for (let i = 0; i + 1 < edges.length; i++) {
      const [a, z] = [edges[i], edges[i + 1]];
      const n = Math.max(1, Math.round((z - a) / b.interval));
      let interval = (z - a) / n;
      while (a + n * interval < z) interval += interval * Number.EPSILON;
      // A stretch that ends at a break is fitted to the trajectory before the
      // break only, its closing instant included (endingBefore).
      const seg = await cut({ ...b, interval }, [a, a + n * interval], i + 2 < edges.length ? endingBefore(spice, z) : spice);
      if (seg.recordCount !== n) throw new Error(`body ${b.id}: a stretch between breaks was cut into ${seg.recordCount} records, not ${n}`);
      ephem.push(seg);
      first = Math.min(first, seg.tStart);
      last = Math.max(last, seg.tStart + seg.recordCount * seg.interval);
    }
    coverage = [Math.max(coverage[0], first), Math.min(coverage[1], last)];
  }
  ephem.sort((a, b) => a.target - b.target || a.tStart - b.tStart);

  const orient = [];
  for (const o of config.orient ?? []) orient.push(await sliceOrient(spice, o, window));
  orient.sort((a, b) => a.body - b.body);

  // Sites. By default latitude is planetocentric and the site sits on a sphere
  // of the body's first radius, as it always has. With "geodeticSites": true
  // at the top of the configuration, latitude is geodetic and altKm is height
  // above the body's spheroid along its normal (SPICE's georec), and the blob's
  // header says so (flag bit 1), which makes the library take "up" as that
  // normal. The choice is one per blob, because the format has no room for one
  // per site.
  const geodetic = config.geodeticSites === true;
  const sites = [];
  for (const s of config.sites ?? []) {
    const body = bodies.find((b) => b.id === s.body);
    const lon = (s.lonDeg * Math.PI) / 180, lat = (s.latDeg * Math.PI) / 180, alt = s.altKm ?? 0;
    if (geodetic) {
      const radii = body?.radii;
      if (!radii || !radii.every((v) => v > 0)) throw new Error(`site ${s.id}: geodetic sites need radii for body ${s.body}`);
      if (radii[0] !== radii[1]) throw new Error(`site ${s.id}: geodetic latitude is defined on a spheroid, and body ${s.body} has unequal equatorial radii`);
      const [a, , c] = radii;
      const e2 = 1 - (c * c) / (a * a);
      const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2); // the prime vertical radius
      sites.push({ id: s.id, body: s.body, position: [(n + alt) * Math.cos(lat) * Math.cos(lon), (n + alt) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + alt) * Math.sin(lat)] });
      continue;
    }
    const r = (body?.radii?.[0] ?? 0) + alt;
    sites.push({ id: s.id, body: s.body, position: [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)] });
  }
  sites.sort((a, b) => a.id - b.id);

  // TIME pieces: an entry that names a spacecraft clock ("sclk") is derived from
  // the SCLK kernel within its tolerance, and one marked "unix" from the
  // leapseconds kernel (tools/sclk-time.mjs); any other entry is one explicit
  // piece, written as given, or with "gap": true a reading from which the
  // base (and context) is refused until its next piece. Any entry may name a
  // "context" (0 to 255); the blob then selects pieces by context as well as
  // base. An explicit piece may state its error bound as "maxErrorSeconds";
  // derived pieces carry the error the slicer measured.
  const pieces = [];
  const timeFit = [];
  for (const t of config.time ?? []) {
    if (t.sclk !== undefined || t.unix) {
      const derived = t.unix ? await unixTimePieces(spice, t, window) : await sclkTimePieces(spice, t, window);
      pieces.push(...derived.pieces);
      timeFit.push(derived.fit);
    } else {
      const piece = t.gap ? { base: t.base, hostStart: t.hostStart, etStart: 0, rate: 0, gap: true }
        : { base: t.base, hostStart: t.hostStart, etStart: window[0] + (t.etOffset ?? 0), rate: t.rate ?? 1 };
      if (t.context !== undefined) piece.context = t.context;
      if (!t.gap && t.maxErrorSeconds !== undefined) piece.maxErr = t.maxErrorSeconds;
      pieces.push(piece);
    }
  }
  // A piece is selected by its base (and context) and the reading alone, so
  // two derived entries that share both must not cover the same readings: each
  // checks its own partitions against one another, and this checks them
  // against the other entry's.
  const spans = timeFit.flatMap((f) => f.partitions.map((q) => ({ key: timeKey(f), base: f.base, first: q.hostFirst, last: q.hostLast })))
    .sort((x, y) => x.key - y.key || x.first - y.first);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].key === spans[i - 1].key && spans[i].first <= spans[i - 1].last) {
      throw new Error(`TIME: two entries of time base ${spans[i].base} cover the same readings (host seconds ${spans[i].first} to ${Math.min(spans[i].last, spans[i - 1].last)}), so the base cannot tell them apart; give each its own base or its own "context"`);
    }
  }
  // Written sorted by base, then start, as the format requires; two entries of
  // the config that put a piece of one base at the same reading are refused.
  const time = sortTime(pieces);

  const created = config.created ? await et(config.created) : window[0];
  const report = {
    slicer: SLICER_VERSION, name: config.name, window: config.window, windowEt: window, kernels,
    ephem: ephem.map(({ records, ...rest }) => ({ ...rest, bytes: records.length })),
    orient: orient.map(({ records, ...rest }) => ({ ...rest, bytes: records.length })),
    sites, time,
  };
  const prov = {
    slicer: SLICER_VERSION, name: config.name, window: config.window, kernels,
    ephem: report.ephem.map((s) => ({ target: s.target, center: s.center, maxPosErrKm: s.maxPosErr, maxVelErrKmS: s.maxVelErr })),
    orient: report.orient.map((s) => ({ body: s.body, maxErrRad: s.maxErr })),
  };
  if (timeFit.length) {
    report.timeFit = timeFit;
    prov.time = timeFit.map((f) => ({ base: f.base, ...(f.context === undefined ? {} : { context: f.context }), ...(f.unix ? { unix: true } : { sclk: f.sclk }), pieces: f.pieces, ...(f.gaps ? { gaps: f.gaps } : {}), toleranceS: f.toleranceSeconds, maxErrS: f.maxErrSeconds }));
  }
  const rootIsSsb = roots[0].id === 0;
  // "checksum": "fletcher32" in the configuration writes that sum where the
  // CRC-32 would go and says so in the header (flag bit 4).
  const blob = buildBlob({ checksum: config.checksum, time, bodies, ephem, orient, sites, prov, flags: (rootIsSsb ? 1 : 0) | (geodetic && sites.length ? 2 : 0), created, coverage });
  if (breaksFound.length) report.breaksFound = breaksFound;
  if (geodetic) report.geodeticSites = true;
  if (config.checksum && config.checksum !== 'crc32') report.checksum = config.checksum;
  report.bytes = blob.length;
  report.coverageEt = coverage;
  return { blob, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [configPath, outPath, reportPath] = process.argv.slice(2);
  if (!configPath || !outPath) {
    console.error('usage: node tools/slicer.mjs <config.json> <out.slb> [report.json]');
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const kernelDir = process.env.SPICE_LITE_KERNELS ?? resolve(dirname(resolve(configPath)), 'kernels');
  const { blob, report } = await slice(config, kernelDir, dirname(resolve(configPath)));
  writeFileSync(outPath, blob);
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${outPath}: ${blob.length} bytes`);
  for (const s of report.ephem) {
    console.log(`  ephem ${s.target} wrt ${s.center}: ${s.recordCount} records, degree ${s.degree}, ${s.bytes} bytes, max error ${s.maxPosErr.toExponential(2)} km, ${s.maxVelErr.toExponential(2)} km/s`);
  }
  for (const s of report.orient) {
    console.log(`  orient ${s.body}: ${s.recordCount} records, degree ${s.degree}, ${s.bytes} bytes, max error ${s.maxErr.toExponential(2)} rad`);
  }
  for (const f of report.timeFit ?? []) {
    console.log(`  time base ${f.base}${f.context === undefined ? '' : `, context ${f.context},`} from ${f.unix ? 'Unix time' : `clock ${f.sclk}`}: ${f.pieces} pieces${f.gaps ? ` and ${f.gaps} gaps` : ''}, max error ${f.maxErrSeconds.toExponential(2)} s (tolerance ${f.toleranceSeconds.toExponential(2)} s)`);
  }
}
