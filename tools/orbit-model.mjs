// The compact orbit model of EPHEM segment kind 4 (SPEC.md), ground side: a
// mirror of the flight library's evaluation, the packing of a record, and the
// least-squares fit of one record to sampled states. The slicer uses these; the
// flight library does not.
//
// A record is 19 numbers in this order (see RECORD_FIELDS): six elements at the
// record's mid epoch, a double-precision rate for the mean argument of
// latitude, six single-precision rates, and six single-precision harmonic
// coefficients. The model is the GPS broadcast ephemeris form (Keplerian
// elements, linear rates, and corrections in twice the argument of latitude),
// with the eccentricity carried as a vector so that circular orbits are regular.

export const RECORD_BYTES = 104;
export const E_MAX = 0.9;
export const KEPLER_ITERATIONS = 12;
export const RECORD_FIELDS = [
  'a', 'ex', 'ey', 'inc', 'node', 'lam', 'lamRate',
  'aRate', 'exRate', 'eyRate', 'incRate', 'nodeRate', 'lamQuad',
  'cuc', 'cus', 'crc', 'crs', 'cic', 'cis',
];
const NP = RECORD_FIELDS.length;

// State (km, km/s) at tau seconds from the record's mid epoch, or null where the
// flight library answers unsupported. Same operations in the same order as
// eval_orbit in src/spice_lite.c, with Math.sin and Math.cos in place of the
// library's own.
export function orbitEval(p, tau) {
  const a = p[0] + p[7] * tau;
  const ex = p[1] + p[8] * tau;
  const ey = p[2] + p[9] * tau;
  const inc = p[3] + p[10] * tau;
  const node = p[4] + p[11] * tau;
  const lam = p[5] + (p[6] + p[12] * tau) * tau;
  const lamDot = p[6] + 2 * p[12] * tau;
  const e2 = ex * ex + ey * ey;
  if (!(a > 0) || !Number.isFinite(a) || !(e2 <= E_MAX * E_MAX) || !(Math.abs(lam) <= 1e6)) return null;
  const sl = Math.sin(lam), cl = Math.cos(lam);
  // Kepler's equation in the offset G = F - lam: G = A cos G + B sin G.
  const A = ex * sl - ey * cl, B = ex * cl + ey * sl;
  let G = 0, sg = 0, cg = 1, done = false;
  for (let it = 0; it < KEPLER_ITERATIONS && !done; it++) {
    const d = (G - (A * cg + B * sg)) / (1 + (A * sg - B * cg));
    G -= d;
    if (Math.abs(d) <= 1e-8) {
      [sg, cg] = [sg - cg * d, cg + sg * d];
      done = true;
    } else {
      sg = Math.sin(G); cg = Math.cos(G);
    }
  }
  if (!done) return null;
  const sf = sl * cg + cl * sg, cf = cl * cg - sl * sg;
  const rho = 1 - (ex * cf + ey * sf);
  const fDot = (lamDot + (p[8] * sf - p[9] * cf)) / rho;
  const w = Math.sqrt(1 - e2);
  const beta = 1 / (1 + w);
  const betaDot = ((ex * p[8] + ey * p[9]) * beta * beta) / w;
  const D = ey * cf - ex * sf;
  const dDot = (p[9] * cf - p[8] * sf) - (ey * sf + ex * cf) * fDot;
  const xn = (cf - ex) - beta * ey * D;
  const yn = (sf - ey) + beta * ex * D;
  const xnDot = (-sf * fDot - p[8]) - ((betaDot * ey + beta * p[9]) * D + beta * ey * dDot);
  const ynDot = (cf * fDot - p[9]) + ((betaDot * ex + beta * p[8]) * D + beta * ex * dDot);
  const r = a * rho;
  const rDot = p[7] * rho - a * ((p[8] * cf + p[9] * sf) + D * fDot);
  const cu = xn / rho, su = yn / rho;
  const uDot = (xn * ynDot - yn * xnDot) / (rho * rho);
  const c2 = cu * cu - su * su, s2 = 2 * cu * su;
  const du = p[13] * c2 + p[14] * s2;
  const dr = p[15] * c2 + p[16] * s2;
  const di = p[17] * c2 + p[18] * s2;
  const twoU = 2 * uDot;
  const ucDot = uDot + twoU * (p[14] * c2 - p[13] * s2);
  const rcDot = rDot + twoU * (p[16] * c2 - p[15] * s2);
  const icDot = p[10] + twoU * (p[18] * c2 - p[17] * s2);
  const sd = Math.sin(du), cd = Math.cos(du);
  const cuc = cu * cd - su * sd, suc = su * cd + cu * sd;
  const rc = r + dr;
  const xp = rc * cuc, yp = rc * suc;
  const xpDot = rcDot * cuc - yp * ucDot, ypDot = rcDot * suc + xp * ucDot;
  const si = Math.sin(inc + di), ci = Math.cos(inc + di);
  const so = Math.sin(node), co = Math.cos(node);
  const x = xp * co - yp * ci * so;
  const y = xp * so + yp * ci * co;
  const z = yp * si;
  return [
    x, y, z,
    (xpDot * co - ypDot * ci * so) + yp * si * so * icDot - y * p[11],
    (xpDot * so + ypDot * ci * co) - yp * si * co * icDot + x * p[11],
    ypDot * si + yp * ci * icDot,
  ];
}

// The stored form: fields 7 to 18 are single precision in the blob, so the
// slicer rounds them before it measures anything.
export function roundRecord(p) {
  const q = Float64Array.from(p);
  for (let j = 7; j < NP; j++) q[j] = Math.fround(q[j]);
  return q;
}

export function packRecord(p, view, offset) {
  for (let j = 0; j < 7; j++) view.setFloat64(offset + 8 * j, p[j], true);
  for (let j = 7; j < NP; j++) view.setFloat32(offset + 56 + 4 * (j - 7), p[j], true);
}

export function unpackRecord(view, offset) {
  const p = new Float64Array(NP);
  for (let j = 0; j < 7; j++) p[j] = view.getFloat64(offset + 8 * j, true);
  for (let j = 7; j < NP; j++) p[j] = view.getFloat32(offset + 56 + 4 * (j - 7), true);
  return p;
}

// ---- fitting ------------------------------------------------------------------

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Osculating elements of this model's set from one state and a gravitational
// parameter. Used only to start the fit.
export function osculating(s, gm) {
  const r = s.slice(0, 3), v = s.slice(3, 6);
  const rn = Math.hypot(...r);
  const h = cross(r, v), hn = Math.hypot(...h);
  const a = 1 / (2 / rn - dot(v, v) / gm);
  const inc = Math.acos(Math.max(-1, Math.min(1, h[2] / hn)));
  const node = Math.hypot(h[0], h[1]) > 1e-12 * hn ? Math.atan2(h[0], -h[1]) : 0;
  const nhat = [Math.cos(node), Math.sin(node), 0];
  const mhat = cross(h.map((c) => c / hn), nhat);
  const vxh = cross(v, h);
  const evec = [0, 1, 2].map((k) => vxh[k] / gm - r[k] / rn);
  const ex = dot(evec, nhat), ey = dot(evec, mhat);
  const X = dot(r, nhat), Y = dot(r, mhat);
  const w = Math.sqrt(Math.max(0, 1 - ex * ex - ey * ey)), beta = 1 / (1 + w);
  const cf = ex + ((1 - ex * ex * beta) * X - ex * ey * beta * Y) / (a * w);
  const sf = ey + ((1 - ey * ey * beta) * Y - ex * ey * beta * X) / (a * w);
  const F = Math.atan2(sf, cf);
  return [a, ex, ey, inc, node, F - ex * sf + ey * cf];
}

const unwrap = (angles) => {
  const out = [angles[0]];
  for (let i = 1; i < angles.length; i++) {
    let d = (angles[i] - angles[i - 1]) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    out.push(out[i - 1] + d);
  }
  return out;
};

// Solves the symmetric system M x = b in place by Gaussian elimination with
// partial pivoting; returns null if a pivot vanishes.
function solve(M, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (!(Math.abs(M[piv][c]) > 0)) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r][k] -= f * M[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// Fits one record. samples is a list of { tau, s } with tau in seconds from the
// record's mid epoch and s a state in km and km/s; gm is an estimate of the
// center's gravitational parameter, used for the starting point and to weigh
// velocity against position (the model itself carries no gm); half is half the
// record length. Returns the 19 numbers, already rounded to their stored
// precision, or throws if the arc is not an ellipse this model accepts.
export function fitRecord(samples, gm, half, { harmonics = true, iterations = 40 } = {}) {
  const osc = samples.map((q) => osculating(q.s, gm));
  if (osc.some((o) => !(o[0] > 0) || !(o[1] * o[1] + o[2] * o[2] < E_MAX * E_MAX))) {
    throw new Error('orbit model: the arc is not an ellipse with eccentricity under ' + E_MAX);
  }
  const cols = [0, 1, 2, 3, 4, 5].map((j) => osc.map((o) => o[j]));
  cols[4] = unwrap(cols[4]);
  cols[5] = unwrap(cols[5]);
  // Start from a straight line through each osculating element.
  const p = new Float64Array(NP);
  const rateIndex = [7, 8, 9, 10, 11, 6];
  const n = samples.length;
  const tm = samples.reduce((s, q) => s + q.tau, 0) / n;
  const tv = samples.reduce((s, q) => s + (q.tau - tm) ** 2, 0);
  for (let j = 0; j < 6; j++) {
    const ym = cols[j].reduce((s, v) => s + v, 0) / n;
    const slope = tv > 0 ? samples.reduce((s, q, i) => s + (q.tau - tm) * (cols[j][i] - ym), 0) / tv : 0;
    p[j] = ym - slope * tm;
    p[rateIndex[j]] = slope;
  }
  p[5] -= 2 * Math.PI * Math.round(p[5] / (2 * Math.PI));
  p[4] -= 2 * Math.PI * Math.round(p[4] / (2 * Math.PI));

  const a0 = p[0];
  const tscale = Math.sqrt((a0 * a0 * a0) / gm); // seconds per radian of orbit
  const h = Math.max(half, 1);
  // Parameter scales: a change of one scale unit moves the position by about a
  // kilometer somewhere in the record.
  const scale = [1, 1 / a0, 1 / a0, 1 / a0, 1 / a0, 1 / a0, 1 / (a0 * h),
    1 / h, 1 / (a0 * h), 1 / (a0 * h), 1 / (a0 * h), 1 / (a0 * h), 1 / (a0 * h * h),
    1 / a0, 1 / a0, 1, 1, 1 / a0, 1 / a0];
  const free = [];
  for (let j = 0; j < NP; j++) if (harmonics || j < 13) free.push(j);
  const residual = (q) => {
    const out = new Float64Array(6 * n);
    for (let i = 0; i < n; i++) {
      const m = orbitEval(q, samples[i].tau);
      if (!m) return null;
      for (let k = 0; k < 3; k++) {
        out[6 * i + k] = m[k] - samples[i].s[k];
        out[6 * i + 3 + k] = (m[k + 3] - samples[i].s[k + 3]) * tscale;
      }
    }
    return out;
  };
  const cost = (r) => { let s = 0; for (const v of r) s += v * v; return s; };
  let r = residual(p);
  if (!r) throw new Error('orbit model: the starting point is outside the model');
  let c = cost(r);
  let mu = 1e-3;
  const nf = free.length;
  for (let it = 0; it < iterations; it++) {
    const J = [];
    for (const j of free) {
      const step = 1e-4 * scale[j];
      const plus = Float64Array.from(p), minus = Float64Array.from(p);
      plus[j] += step; minus[j] -= step;
      const rp = residual(plus), rm = residual(minus);
      if (!rp || !rm) throw new Error('orbit model: the fit left the model');
      const col = new Float64Array(6 * n);
      for (let i = 0; i < 6 * n; i++) col[i] = (rp[i] - rm[i]) / 2e-4; // per scale unit
      J.push(col);
    }
    const JtJ = Array.from({ length: nf }, () => new Array(nf).fill(0));
    const Jtr = new Array(nf).fill(0);
    for (let x = 0; x < nf; x++) {
      for (let y = x; y < nf; y++) {
        let s = 0;
        for (let i = 0; i < 6 * n; i++) s += J[x][i] * J[y][i];
        JtJ[x][y] = s; JtJ[y][x] = s;
      }
      let s = 0;
      for (let i = 0; i < 6 * n; i++) s += J[x][i] * r[i];
      Jtr[x] = s;
    }
    let improved = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const M = JtJ.map((row, x) => row.map((v, y) => (x === y ? v * (1 + mu) + 1e-300 : v)));
      const delta = solve(M, Jtr.map((v) => -v));
      if (delta) {
        const q = Float64Array.from(p);
        free.forEach((j, x) => { q[j] += delta[x] * scale[j]; });
        const rq = residual(q);
        if (rq && cost(rq) < c) {
          const gain = c - cost(rq);
          p.set(q); r = rq; c = cost(rq); mu = Math.max(mu / 10, 1e-12);
          improved = gain > 1e-12 * c;
          break;
        }
      }
      mu *= 10;
    }
    if (!improved) break;
  }
  return roundRecord(p);
}

// ---- slicing ------------------------------------------------------------------

// Cuts one kind 4 segment: fits each record to states sampled from CSPICE and
// measures the worst error of the stored record against CSPICE on a denser
// grid that includes both record edges, as the slicer does for kind 1. spec is
// a body entry of the slicer configuration with "model": "orbit"; interval is
// the record length, fitSamples and checks override the sampling.
export async function sliceOrbit(spice, spec, window, parentId) {
  const [t0, t1] = window;
  const dt = spec.interval;
  const count = Math.ceil((t1 - t0) / dt - 1e-9);
  const state = async (t) => {
    const s = await spice.spkezr(String(spec.id), t, 'J2000', 'NONE', String(parentId));
    return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z];
  };
  // The model carries no gravitational parameter, but the fit wants one to
  // start from. Estimate it from the trajectory itself: the central
  // acceleration, from a velocity difference, times the radius squared.
  let gm = 0;
  for (let j = 0; j < 8; j++) {
    const t = t0 + (dt * (j + 0.5)) / 8;
    const [a, m, b] = [await state(t - 1), await state(t), await state(t + 1)];
    const rn = Math.hypot(m[0], m[1], m[2]);
    let ar = 0;
    for (let k = 0; k < 3; k++) ar += (((b[k + 3] - a[k + 3]) / 2) * m[k]) / rn;
    gm += (-ar * rn * rn) / 8;
  }
  if (!(gm > 0)) throw new Error(`body ${spec.id}: the trajectory does not look like an orbit around ${parentId}`);
  const nFit = spec.fitSamples ?? Math.min(720, Math.max(48, Math.ceil(dt / 60)));
  const nCheck = spec.checks ?? 4 * nFit;
  const records = new Uint8Array(count * RECORD_BYTES);
  const view = new DataView(records.buffer);
  let maxPos = 0, maxVel = 0;
  for (let k = 0; k < count; k++) {
    const tm = t0 + (k + 0.5) * dt;
    const samples = [];
    for (let j = 0; j <= nFit; j++) {
      const tau = (j / nFit - 0.5) * dt;
      samples.push({ tau, s: await state(tm + tau) });
    }
    let p;
    try {
      p = fitRecord(samples, gm, dt / 2, { harmonics: spec.harmonics ?? true });
    } catch (err) {
      throw new Error(`body ${spec.id}, record ${k}: ${err.message}`);
    }
    packRecord(p, view, k * RECORD_BYTES);
    const stored = unpackRecord(view, k * RECORD_BYTES);
    for (let j = 0; j <= nCheck; j++) {
      const tau = (j / nCheck - 0.5) * dt;
      const truth = await state(tm + tau);
      const m = orbitEval(stored, tau);
      if (!m) throw new Error(`body ${spec.id}, record ${k}: the fitted record is outside the model`);
      maxPos = Math.max(maxPos, Math.hypot(m[0] - truth[0], m[1] - truth[1], m[2] - truth[2]));
      maxVel = Math.max(maxVel, Math.hypot(m[3] - truth[3], m[4] - truth[4], m[5] - truth[5]));
    }
  }
  return {
    target: spec.id, center: parentId, kind: 4, source: spec.predicted ? 1 : 0, degree: 0,
    recordCount: count, tStart: t0, interval: dt, maxPosErr: maxPos, maxVelErr: maxVel, records,
  };
}
