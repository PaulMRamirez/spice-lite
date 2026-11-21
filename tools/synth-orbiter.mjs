// Synthetic orbiter trajectories for testing the compact orbit segment (EPHEM
// kind 4). There is no real orbiter kernel among the test fixtures, so this
// integrates one: a point-mass field plus the J2 term about a fixed pole,
// nothing else (no higher gravity terms, no third bodies, no drag, no radiation
// pressure). It is a realistic shape, not a real mission, and everything built
// from it says so.
//
// The integrator is an eighth-order symplectic composition of the leapfrog step
// (three nested triple jumps: Yoshida 1990), with a fixed step and only add,
// subtract, multiply, divide, and square root in the loop, so the trajectory is
// reproducible bit for bit. The states go into an SPK type 13 (Hermite) segment
// written by cspice-wasm and furnished like any other kernel, so the slicer and
// the tests read the synthetic orbiter through CSPICE exactly as they would a
// real one.

import { createHash } from 'node:crypto';

const DEG = Math.PI / 180;

// Triple-jump weights 1 / (2 - 2^(1/(2k+1))) for k = 1, 2, 3, as literals.
const JUMP = [1.3512071919596578, 1.1746717580893635, 1.1161829393253857];

// Substep weights of the eighth-order scheme: 27 leapfrog steps per step.
const WEIGHTS = (() => {
  let w = [1];
  for (const x1 of JUMP) {
    const x0 = 1 - 2 * x1;
    w = [...w.map((v) => v * x1), ...w.map((v) => v * x0), ...w.map((v) => v * x1)];
  }
  return w;
})();

function accel(r, f, out) {
  const { gm, j2, radius, pole } = f;
  const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  const rn = Math.sqrt(r2);
  const z = r[0] * pole[0] + r[1] * pole[1] + r[2] * pole[2];
  const k = (1.5 * gm * j2 * radius * radius) / (r2 * r2 * rn);
  const c = gm / (r2 * rn) + k * (1 - (5 * z * z) / r2);
  for (let i = 0; i < 3; i++) out[i] = -c * r[i] - 2 * k * z * pole[i];
}

// Energy per unit mass, conserved by the field; the tests watch it.
export function energy(s, f) {
  const { gm, j2, radius, pole } = f;
  const r2 = s[0] * s[0] + s[1] * s[1] + s[2] * s[2], rn = Math.sqrt(r2);
  const z = s[0] * pole[0] + s[1] * pole[1] + s[2] * pole[2];
  return 0.5 * (s[3] * s[3] + s[4] * s[4] + s[5] * s[5]) - gm / rn + (gm * j2 * radius * radius * (3 * z * z - r2)) / (2 * r2 * r2 * rn);
}

function step(s, h, f, a) {
  for (const w of WEIGHTS) {
    const hw = h * w, half = 0.5 * hw;
    for (let i = 0; i < 3; i++) s[i] += half * s[i + 3];
    accel(s, f, a);
    for (let i = 0; i < 3; i++) s[i + 3] += hw * a[i];
    for (let i = 0; i < 3; i++) s[i] += half * s[i + 3];
  }
}

// Classical elements (kilometers and degrees, in J2000) to a state.
export function elementsToState(el, gm) {
  const { a, e } = el;
  const inc = el.incDeg * DEG, node = el.nodeDeg * DEG, argp = el.argpDeg * DEG, M = el.meanAnomDeg * DEG;
  let E = M;
  for (let i = 0; i < 50; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const b = Math.sqrt(1 - e * e);
  const xp = a * (Math.cos(E) - e), yp = a * b * Math.sin(E);
  const rn = a * (1 - e * Math.cos(E)), nn = Math.sqrt(gm / (a * a * a));
  const vxp = (-a * a * nn * Math.sin(E)) / rn, vyp = (a * a * nn * b * Math.cos(E)) / rn;
  const [co, so, ci, si, cw, sw] = [Math.cos(node), Math.sin(node), Math.cos(inc), Math.sin(inc), Math.cos(argp), Math.sin(argp)];
  const P = [co * cw - so * sw * ci, so * cw + co * sw * ci, sw * si];
  const Q = [-co * sw - so * cw * ci, -so * sw + co * cw * ci, cw * si];
  return [0, 1, 2].map((k) => xp * P[k] + yp * Q[k]).concat([0, 1, 2].map((k) => vxp * P[k] + vyp * Q[k]));
}

const fieldOf = (spec) => {
  const ra = (spec.poleRaDeg ?? 0) * DEG, dec = (spec.poleDecDeg ?? 90) * DEG;
  const pole = spec.poleDecDeg === undefined || spec.poleDecDeg === 90 ? [0, 0, 1] : [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  return { gm: spec.gm, j2: spec.j2, radius: spec.radius, pole };
};

// Integrates the orbiter a spec describes from t0 to at least t1 and returns
// samples every spec.sample seconds (default 60): epochs and states as the flat
// arrays writeSpkType13 takes. The elements in the spec are osculating at t0.
export function integrate(spec, t0, t1) {
  const f = fieldOf(spec);
  const h = spec.step ?? 10, every = Math.round((spec.sample ?? 60) / h);
  const count = Math.ceil((t1 - t0) / (h * every) - 1e-9) + 1;
  const epochs = new Float64Array(count), states = new Float64Array(6 * count);
  const s = Float64Array.from(elementsToState(spec.elements, f.gm));
  const a = new Float64Array(3);
  for (let i = 0; i < count; i++) {
    epochs[i] = t0 + i * every * h;
    states.set(s, 6 * i);
    if (i + 1 < count) for (let k = 0; k < every; k++) step(s, h, f, a);
  }
  return { epochs, states, field: f };
}

// Generates the orbiter over [window[0] - pad, window[1] + pad], writes it as an
// SPK type 13 segment in the given cspice-wasm engine (which also furnishes it),
// and returns a provenance entry for it.
export async function furnishSynthetic(spice, spec, window) {
  const pad = spec.pad ?? 600;
  const { epochs, states } = integrate(spec, window[0] - pad, window[1] + pad);
  await spice.writeSpkType13(spec.name, spec.body, spec.center, 'J2000', 'SYNTHETIC', spec.degree ?? 11, epochs, states);
  const sha256 = createHash('sha256').update(new Uint8Array(epochs.buffer)).update(new Uint8Array(states.buffer)).digest('hex');
  return { name: spec.name, sha256, synthetic: true };
}
