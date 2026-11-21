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
import { sclkTimePieces } from './sclk-time.mjs';
import { sliceOrbit } from './orbit-model.mjs';

export const SLICER_VERSION = '0.1.0';

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
// time base, then by host_start, with no two pieces of one base starting at the
// same reading. The library refuses any other order, because it finds a piece
// by binary search. Returns a sorted copy; throws on a piece it cannot place.
export function sortTime(time) {
  for (const t of time) {
    if (!Number.isInteger(t.base) || t.base < 0 || t.base > 65535) throw new Error(`TIME: time base ${t.base} is not a 16-bit unsigned integer`);
    if (![t.hostStart, t.etStart, t.rate].every(Number.isFinite)) throw new Error(`TIME: a piece of time base ${t.base} holds a number that is not finite`);
  }
  const sorted = [...time].sort((a, b) => a.base - b.base || a.hostStart - b.hostStart);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].base === sorted[i - 1].base && sorted[i].hostStart === sorted[i - 1].hostStart) {
      throw new Error(`TIME: two pieces of time base ${sorted[i].base} start at host second ${sorted[i].hostStart}; a reading there would have two answers`);
    }
  }
  return sorted;
}

function buildBlob(model) {
  const { bodies, ephem, orient, sites, prov, flags, created } = model;
  const time = sortTime(model.time);
  const sections = [];

  const mk = (type, required, entries, entrySize, fill, tail = []) => {
    const table = new Uint8Array(entries.length * entrySize);
    const view = new DataView(table.buffer);
    sections.push({ type, required, count: entries.length, table, view, entries, entrySize, fill, tail });
  };

  if (time.length) {
    mk(1, false, time, 32, (v, o, t) => {
      v.setUint16(o, t.base, true);
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
  v.setUint32(12, crc32(blob.subarray(16)), true);
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
  for (const b of bodies) {
    if (b.parentIndex === -1 || b.noSegment) continue;
    const w = b.window ? [await et(b.window.start), await et(b.window.stop)] : window;
    const seg = b.model === 'orbit' ? await sliceOrbit(spice, b, w, b.parent) : await sliceEphem(spice, b, w, b.parent);
    ephem.push(seg);
    coverage = [Math.max(coverage[0], seg.tStart), Math.min(coverage[1], seg.tStart + seg.recordCount * seg.interval)];
  }
  ephem.sort((a, b) => a.target - b.target || a.tStart - b.tStart);

  const orient = [];
  for (const o of config.orient ?? []) orient.push(await sliceOrient(spice, o, window));
  orient.sort((a, b) => a.body - b.body);

  const sites = [];
  for (const s of config.sites ?? []) {
    const body = bodies.find((b) => b.id === s.body);
    const r = (body?.radii?.[0] ?? 0) + (s.altKm ?? 0);
    const lon = (s.lonDeg * Math.PI) / 180, lat = (s.latDeg * Math.PI) / 180;
    sites.push({ id: s.id, body: s.body, position: [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)] });
  }
  sites.sort((a, b) => a.id - b.id);

  // TIME pieces: an entry that names a spacecraft clock ("sclk") is derived from
  // the SCLK kernel within its tolerance (tools/sclk-time.mjs); any other entry
  // is one explicit piece, written as given.
  const pieces = [];
  const timeFit = [];
  for (const t of config.time ?? []) {
    if (t.sclk !== undefined) {
      const derived = await sclkTimePieces(spice, t, window);
      pieces.push(...derived.pieces);
      timeFit.push(derived.fit);
    } else {
      pieces.push({ base: t.base, hostStart: t.hostStart, etStart: window[0] + (t.etOffset ?? 0), rate: t.rate ?? 1 });
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
    prov.time = timeFit.map((f) => ({ base: f.base, sclk: f.sclk, pieces: f.pieces, toleranceS: f.toleranceSeconds, maxErrS: f.maxErrSeconds }));
  }
  const rootIsSsb = roots[0].id === 0;
  const blob = buildBlob({ time, bodies, ephem, orient, sites, prov, flags: rootIsSsb ? 1 : 0, created, coverage });
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
    console.log(`  time base ${f.base} from clock ${f.sclk}: ${f.pieces} pieces, max error ${f.maxErrSeconds.toExponential(2)} s (tolerance ${f.toleranceSeconds.toExponential(2)} s)`);
  }
}
