// Finds the times in a trajectory that no fitted record should span: burns, and
// seams where a reconstructed kernel hands over from one orbit solution to the
// next. Ground software, used by the slicer when a body asks for "findBreaks".
//
// The test needs no force model. The trajectory is sampled every stepSeconds,
// and each sample's position and velocity are compared with the cubic through
// its four neighbors (two on each side). On a smooth orbit that cubic is good
// to millimeters and hundredths of a millimeter per second at a 10 s step; a
// sample that misses it by more than positionKm or velocityKmS has a
// discontinuity, or thrust, within two steps of it. Flagged samples closer
// together than mergeSeconds are one event. An event no wider than the stencil
// of one jump is a step, and is located to the nearest representable instant
// by bisection; a wider one is a burn, and gets a break before it and after it
// so that it becomes a short stretch of its own, cut again inside so that no
// record under thrust is longer than burnSeconds.
//
// What it cannot see: an event within two steps of either end of the window (the
// stencil does not reach), and anything smaller than the thresholds. A step
// below them is, by the same token, too small to hurt a fit much.

export const BREAK_DEFAULTS = { stepSeconds: 10, positionKm: 2e-4, velocityKmS: 2e-6, mergeSeconds: 120, burnSeconds: 120 };

export async function findBreaks(spice, target, center, [t0, t1], options = {}) {
  const o = { ...BREAK_DEFAULTS, ...options };
  for (const k of Object.keys(options)) if (!(k in BREAK_DEFAULTS)) throw new Error(`findBreaks: unknown option "${k}"`);
  for (const k of Object.keys(BREAK_DEFAULTS)) if (!(o[k] > 0) || !Number.isFinite(o[k])) throw new Error(`findBreaks: "${k}" must be a positive number`);
  const h = o.stepSeconds, n = Math.floor((t1 - t0) / h);
  const state = async (t) => {
    const s = await spice.spkezr(String(target), t, 'J2000', 'NONE', String(center));
    return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z];
  };
  const norm = (f) => Math.hypot(f(0), f(1), f(2));

  // Pass one: flag samples that miss the cubic through their neighbors.
  const flagged = [];
  const ring = [];
  for (let i = 0; i <= n; i++) {
    ring.push(await state(t0 + i * h));
    if (ring.length < 5) continue;
    const [a, b, c, d, e] = ring;
    const miss = (off) => norm((k) => c[off + k] - (-a[off + k] + 4 * b[off + k] + 4 * d[off + k] - e[off + k]) / 6);
    const p = miss(0), v = miss(3);
    if (p > o.positionKm || v > o.velocityKmS) flagged.push({ i: i - 2, p, v });
    ring.shift();
  }
  const events = [];
  for (const f of flagged) {
    const last = events.at(-1);
    if (last && (f.i - last.b) * h <= o.mergeSeconds) { last.b = f.i; last.p = Math.max(last.p, f.p); last.v = Math.max(last.v, f.v); } else events.push({ a: f.i, b: f.i, p: f.p, v: f.v });
  }

  // How far the state at the middle of [a, b] lies from the Hermite cubic
  // through the states at its ends, in units of the two thresholds. Natural
  // motion contributes next to nothing; a jump anywhere inside contributes
  // about half its size.
  const hermiteMiss = async (a, sa, b, sb) => {
    const m = a + (b - a) / 2, sm = await state(m), w = b - a;
    const p = norm((k) => sm[k] - ((sa[k] + sb[k]) / 2 + (w / 8) * (sa[k + 3] - sb[k + 3])));
    const v = norm((k) => sm[k + 3] - ((1.5 * (sb[k] - sa[k])) / w - (sa[k + 3] + sb[k + 3]) / 4));
    return { m, sm, score: p / o.positionKm + v / o.velocityKmS };
  };
  // Over a span this short natural motion is far below the thresholds, so the
  // plain differences are the jump itself.
  const plainMiss = (a, sa, b, sb) => {
    const w = b - a;
    return norm((k) => sb[k] - sa[k] - (w / 2) * (sa[k + 3] + sb[k + 3])) / o.positionKm + norm((k) => sb[k + 3] - sa[k + 3]) / o.velocityKmS;
  };
  const locate = async (ia, ib) => {
    // The grid interval that holds the step, then bisection inside it.
    let best = null;
    for (let i = Math.max(0, ia - 2); i < Math.min(n, ib + 2); i++) {
      const a = t0 + i * h, b = t0 + (i + 1) * h, sa = await state(a), sb = await state(b);
      const q = await hermiteMiss(a, sa, b, sb);
      if (!best || q.score > best.q.score) best = { a, sa, b, sb, q };
    }
    let { a, sa, b, sb, q } = best;
    while (b - a > 1e-4) {
      const left = await hermiteMiss(a, sa, q.m, q.sm), right = await hermiteMiss(q.m, q.sm, b, sb);
      if (left.score >= right.score) { b = q.m; sb = q.sm; q = left; } else { a = q.m; sa = q.sm; q = right; }
    }
    for (;;) {
      const m = a + (b - a) / 2;
      if (m <= a || m >= b) break;
      const sm = await state(m);
      if (plainMiss(a, sa, m, sm) >= plainMiss(m, sm, b, sb)) { b = m; sb = sm; } else { a = m; sa = sm; }
    }
    return b; // the first instant on the far side of the step
  };

  const found = [];
  const push = async (et, kind, ev) => {
    if (et > t0 && et < t1 && !found.some((f) => f.et === et)) found.push({ et, utc: await spice.et2utc(et, 'ISOC', 3), kind, positionKm: ev.p, velocityKmS: ev.v });
  };
  for (const ev of events) {
    if (ev.b - ev.a <= 3) await push(await locate(ev.a, ev.b), 'step', ev);
    else {
      const a = t0 + (ev.a + 1) * h, b = t0 + (ev.b - 1) * h, parts = Math.max(1, Math.ceil((b - a) / o.burnSeconds));
      await push(a, 'start', ev);
      for (let i = 1; i < parts; i++) await push(a + (i * (b - a)) / parts, 'during', ev);
      await push(b, 'end', ev);
    }
  }
  return found;
}

// The largest double below x.
export function nextBelow(x) {
  if (x === 0) return -Number.MIN_VALUE;
  const f = new Float64Array([x]), u = new BigInt64Array(f.buffer);
  u[0] += x > 0 ? -1n : 1n;
  return f[0];
}

// The engine as a stretch that ends at a break should see it: a state asked
// for at or after "end" is the state at the last instant before it. A fit
// samples its closing endpoint, and at a seam that instant already belongs to
// the next orbit solution; without this the last record before a seam would be
// fitted to, and measured against, one sample from the far side of the step.
export function endingBefore(spice, end) {
  const last = nextBelow(end);
  return new Proxy(spice, {
    get(target, key) {
      if (key === 'spkezr') return (body, t, ...rest) => target.spkezr(body, Math.min(t, last), ...rest);
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
