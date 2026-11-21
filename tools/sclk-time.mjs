// Derives the TIME pieces of a spice-lite blob from a spacecraft clock (SCLK)
// kernel, for the slicer (tools/slicer.mjs). See SPEC.md, "TIME".
//
// A config entry of the form { "base": 3, "sclk": -82, "maxErrorSeconds": 1e-6 }
// asks for the map from that clock to ET over the blob's window as the fewest
// straight lines that stay within the tolerance. CSPICE (sct2e, through
// cspice-wasm) is the truth for the map itself, so spacecraft clock
// coefficients, leap seconds, and the periodic TDB term are all folded in.
//
// Host seconds convention (the full statement is in SPEC.md): the reading the
// host passes is the spacecraft clock's own count, in units of its most
// significant field, with the lesser fields as a fraction carried in the
// microseconds. In SPICE terms: host seconds = ticks / ticksPerCount, where
// ticks is the clock reading as the SCLK kernel counts it within its partition
// (the unit of SCLK_PARTITION_START and SCLK_PARTITION_END) and ticksPerCount
// is the product of every modulus but the first.
//
// The structure of the clock (moduli, partitions, where the coefficient records
// start) is read from the kernel pool and scpart through cspice-wasm, so
// CSPICE's own text kernel reader decides what the kernel says. The numbers
// that matter, the ET at each clock reading, also come from CSPICE.

const US = 1e6; // microsecond readings per host second

// ---- the clock's structure, from the kernel pool ----------------------------

// Reads the type 1 SCLK definition of one clock from the kernels furnished to
// the engine. Values go through gdpool (doubles), since moduli such as 1e12 do
// not fit CSPICE's 32-bit integers.
export async function readSclk(spice, sclk) {
  const id = String(-sclk);
  const names = {
    type: `SCLK_DATA_TYPE_${id}`, system: `SCLK01_TIME_SYSTEM_${id}`, fields: `SCLK01_N_FIELDS_${id}`,
    moduli: `SCLK01_MODULI_${id}`, coeffs: `SCLK01_COEFFICIENTS_${id}`,
  };
  const get = async (key) => {
    const info = await spice.dtpool(names[key]);
    if (!info.found) return undefined;
    if (info.type !== 'N') throw new Error(`SCLK kernel: ${names[key]} holds something that is not a number`);
    return await spice.gdpool(names[key]) ?? undefined;
  };
  const type = await get('type');
  if (!type) throw new Error(`no furnished kernel defines spacecraft clock ${sclk} (${names.type} is missing)`);
  if (type[0] !== 1) throw new Error(`spacecraft clock ${sclk} is SCLK type ${type[0]}; only type 1 is supported`);
  const moduli = await get('moduli'), coeffs = await get('coeffs'), fields = await get('fields'), system = await get('system');
  if (!moduli?.length || !coeffs?.length) throw new Error(`spacecraft clock ${sclk}: the kernel lacks moduli or coefficients`);
  if (fields && fields[0] !== moduli.length) throw new Error(`spacecraft clock ${sclk}: the field count and the moduli disagree`);
  if (coeffs.length % 3 !== 0) throw new Error(`spacecraft clock ${sclk}: the coefficients are not whole records of three`);
  const { pstart: partStart, pstop: partEnd } = await spice.scpart(sclk);
  if (!partStart.length || partStart.length !== partEnd.length) throw new Error(`spacecraft clock ${sclk}: the kernel defines no usable partitions`);
  const ticksPerCount = moduli.slice(1).reduce((a, b) => a * b, 1);
  // Partition bounds are in the clock's own ticks; encoded SCLK (what sct2e
  // takes) is the tick count with every earlier partition's length added and
  // the jump at each partition boundary removed. CSPICE rounds the bounds.
  const partitions = [];
  let enc = 0;
  for (let i = 0; i < partStart.length; i++) {
    const rawStart = Math.round(partStart[i]), rawEnd = Math.round(partEnd[i]);
    if (!(rawEnd > rawStart)) throw new Error(`spacecraft clock ${sclk}: partition ${i + 1} is empty`);
    partitions.push({ partition: i + 1, rawStart, rawEnd, encStart: enc, encEnd: enc + (rawEnd - rawStart) });
    enc += rawEnd - rawStart;
  }
  const recordStarts = [];
  for (let i = 0; i < coeffs.length; i += 3) recordStarts.push(coeffs[i]);
  return { sclk, timeSystem: system?.[0] ?? 1, moduli, ticksPerCount, partitions, recordStarts };
}

// ---- readings ---------------------------------------------------------------

// A reading is a whole number of microseconds of host time, u. The library
// forms host seconds as seconds + microseconds * 1e-6 in 64-bit floats, and the
// slicer must form them the same way so piece boundaries select identically.
export const hostOf = (u) => { const s = Math.floor(u / US); return s + (u - s * US) * 1.0e-6; };

// ---- fitting ----------------------------------------------------------------

function sampleReadings(u0, u1, n) {
  const out = [];
  for (let j = 0; j <= n; j++) {
    const u = j === n ? u1 : u0 + Math.floor(((u1 - u0) * j) / n);
    if (!out.length || u > out[out.length - 1]) out.push(u);
  }
  return out;
}

// The line for readings u0 to u1 of one smooth stretch: the slope of the chord
// between the ends, shifted to halve the largest residual. Where the curve
// bends one way across the piece (everywhere but a piece that straddles an
// inflection of the periodic term) this is the best line in the worst-error
// sense. The error is evaluated with the library's own expression.
async function fitLine(truth, u0, u1, n) {
  const us = sampleReadings(u0, u1, n);
  const hs = us.map(hostOf);
  const ts = [];
  for (const u of us) ts.push(await truth(u));
  const hostStart = hs[0];
  const last = us.length - 1;
  const rate = last > 0 ? (ts[last] - ts[0]) / (hs[last] - hostStart) : 1;
  let lo = 0, hi = 0;
  for (let j = 0; j <= last; j++) {
    const r = ts[j] - (ts[0] + rate * (hs[j] - hostStart));
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  const etStart = ts[0] + (lo + hi) / 2;
  let err = 0;
  for (let j = 0; j <= last; j++) err = Math.max(err, Math.abs(etStart + rate * (hs[j] - hostStart) - ts[j]));
  return { u0, u1, hostStart, etStart, rate, err };
}

// Greedy cover of readings uA to uB: each piece runs as far as it can while its
// worst sampled error stays under the target. For this cost (worst error of the
// best line, which never shrinks when a piece grows) taking the longest piece
// each time gives the fewest pieces.
async function fitStretch(truth, uA, uB, target, n, budget) {
  const pieces = [];
  let u0 = uA;
  while (u0 <= uB) {
    if (pieces.length >= budget.left) throw budget.error();
    let best = await fitLine(truth, u0, uB, n);
    if (best.err > target) {
      let lo = u0, hi = uB; // lo is known to fit (a single reading always does)
      best = await fitLine(truth, u0, u0, n);
      while (hi - lo > Math.max(1, Math.floor((hi - u0) / 4096))) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const f = await fitLine(truth, u0, mid, n);
        if (f.err <= target) { lo = mid; best = f; } else hi = mid;
      }
    }
    pieces.push(best);
    u0 = best.u1 + 1;
  }
  return pieces;
}

// Worst error of one piece against CSPICE on a dense grid that includes both
// ends, independent of the samples the fit used.
async function measure(truth, p, n) {
  let worst = 0, at = p.u0;
  for (const u of sampleReadings(p.u0, p.u1, n)) {
    const e = Math.abs(p.etStart + p.rate * (hostOf(u) - p.hostStart) - (await truth(u)));
    if (e > worst) { worst = e; at = u; }
  }
  return { worst, at, samples: Math.min(n + 1, p.u1 - p.u0 + 1) };
}

// ---- the entry point --------------------------------------------------------

// entry: { base, sclk, maxErrorSeconds, maxPieces?, partition? }
// window: [et0, et1].
// Returns the TIME pieces and a record of the fit for the report and PROV.
export async function sclkTimePieces(spice, entry, window) {
  const tol = entry.maxErrorSeconds;
  const maxPieces = entry.maxPieces ?? 256;
  const who = `time base ${entry.base}, spacecraft clock ${entry.sclk}`;
  if (!Number.isInteger(entry.sclk) || !Number.isInteger(entry.base)) throw new Error(`${who}: base and sclk must be integers`);
  if (!(tol > 0) || !Number.isFinite(tol)) throw new Error(`${who}: maxErrorSeconds must be a positive number`);
  if (!Number.isInteger(maxPieces) || maxPieces < 1) throw new Error(`${who}: maxPieces must be a positive integer`);
  const clock = await readSclk(spice, entry.sclk);
  const T = clock.ticksPerCount;

  let e0, e1;
  try {
    e0 = await spice.sce2c(entry.sclk, window[0]);
    e1 = await spice.sce2c(entry.sclk, window[1]);
  } catch (err) {
    throw new Error(`${who}: the clock kernel does not cover the blob's window (${err.message})`);
  }

  let parts = clock.partitions.filter((p) => p.encEnd > e0 && p.encStart <= e1);
  if (entry.partition !== undefined) {
    parts = parts.filter((p) => p.partition === entry.partition);
    if (!parts.length) throw new Error(`${who}: partition ${entry.partition} does not exist or does not meet the window`);
  }

  // Each partition's stretch of readings inside the window, then the readings
  // where a new line must start: the stretch's first reading and the first
  // reading at or after each coefficient record that begins inside it.
  const stretches = [];
  for (const p of parts) {
    const encOf = (u) => ((u * T) / US - p.rawStart) + p.encStart;
    // Smallest reading whose encoded tick, as computed above, is not below x.
    const firstAtOrAfter = (x) => {
      let u = Math.ceil(((x - p.encStart + p.rawStart) / T) * US);
      while (encOf(u) < x) u++;
      while (encOf(u - 1) >= x) u--;
      return u;
    };
    const uLo = firstAtOrAfter(Math.max(p.encStart, e0));
    const uHi = p.encEnd <= e1 ? firstAtOrAfter(p.encEnd) - 1 : firstAtOrAfter(e1 + Number.EPSILON * Math.abs(e1)) - 1;
    if (uHi < uLo) continue;
    if (uLo < 0 || uHi >= 4294967296 * US) throw new Error(`${who}: partition ${p.partition} has clock counts in the window that a 32-bit seconds field cannot hold`);
    const starts = [uLo];
    for (const c of clock.recordStarts) {
      if (c <= encOf(uLo) || c > encOf(uHi)) continue;
      starts.push(firstAtOrAfter(c));
    }
    starts.sort((a, b) => a - b);
    stretches.push({ p, uLo, uHi, starts: starts.filter((u, i) => i === 0 || u !== starts[i - 1]), encOf });
  }
  if (!stretches.length) throw new Error(`${who}: no clock reading falls inside the blob's window`);
  // One time base selects a piece by the reading alone, so the partitions it
  // covers must not share any reading inside the window.
  const byReading = [...stretches].sort((a, b) => a.uLo - b.uLo);
  for (let i = 1; i < byReading.length; i++) {
    if (byReading[i].uLo <= byReading[i - 1].uHi) {
      const pair = [byReading[i - 1].p.partition, byReading[i].p.partition].sort((x, y) => x - y);
      throw new Error(`${who}: partitions ${pair[0]} and ${pair[1]} share clock readings inside the window (the clock was reset), so one time base cannot tell them apart; give each its own entry with "partition" and its own base, or cut one blob per partition`);
    }
  }

  const budget = {
    left: maxPieces,
    error: () => new Error(`${who}: more than ${maxPieces} linear pieces are needed to hold ${tol} s over the window; raise maxErrorSeconds or maxPieces, or shorten the window`),
  };
  const fitSamples = 128, checkSamples = 2048;
  const out = [];
  const perPartition = [];
  let worst = 0, worstAt = null, samples = 0;
  for (const s of stretches) {
    const truth = (u) => spice.sct2e(entry.sclk, s.encOf(u));
    let count = 0;
    for (let k = 0; k < s.starts.length; k++) {
      const uA = s.starts[k], uB = k + 1 < s.starts.length ? s.starts[k + 1] - 1 : s.uHi;
      // Fit under a slightly tighter target so the dense check has room for
      // what falls between the fit's samples; if a piece still fails the dense
      // check (a discontinuity the kernel text did not announce, say), refit
      // its span tighter and with more samples before giving up.
      let pending = [{ uA, uB, target: 0.9 * tol, n: fitSamples, depth: 0 }];
      while (pending.length) {
        const job = pending.shift();
        const pieces = await fitStretch(truth, job.uA, job.uB, job.target, job.n, budget);
        for (const piece of pieces) {
          const m = await measure(truth, piece, checkSamples);
          if (m.worst > tol) {
            if (job.depth >= 4) throw new Error(`${who}: could not hold ${tol} s near host second ${hostOf(m.at)} (measured ${m.worst} s); the tolerance may be below what 64-bit times resolve there`);
            pending.push({ uA: piece.u0, uB: piece.u1, target: job.target * 0.8, n: job.n * 2, depth: job.depth + 1 });
            continue;
          }
          budget.left--;
          count++;
          samples += m.samples;
          if (m.worst > worst) { worst = m.worst; worstAt = hostOf(m.at); }
          out.push({ base: entry.base, hostStart: piece.hostStart, etStart: piece.etStart, rate: piece.rate });
        }
      }
    }
    perPartition.push({ partition: s.p.partition, hostFirst: hostOf(s.uLo), hostLast: hostOf(s.uHi), pieces: count });
  }
  const fit = {
    base: entry.base, sclk: entry.sclk, timeSystem: clock.timeSystem === 2 ? 'TT' : clock.timeSystem === 1 ? 'TDB' : `system ${clock.timeSystem}`,
    ticksPerHostSecond: T, toleranceSeconds: tol, maxErrSeconds: worst, maxErrAtHostSecond: worstAt,
    pieces: out.length, maxPieces, checkedReadings: samples, partitions: perPartition,
  };
  return { pieces: out, fit };
}
