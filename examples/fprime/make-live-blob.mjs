// Cuts a blob for a run of the demonstration sequence against a real clock, as
// F Prime's Svc/PosixTime reports it: Unix time under TB_WORKSTATION_TIME (time
// base 2). The blob holds the Sun relative to the Earth and the Earth's
// orientation for three days from the given start, and one geodetic site on
// the equator, placed where the Sun will climb through 10 degrees a chosen
// number of seconds after the start, so that the sequence has something to
// wait for and then acts while someone is watching.
//
//   node examples/fprime/make-live-blob.mjs <out.slb> [startUtc] [secondsUntilSunrise]
//
// Kernels: naif0012.tls, pck00011.tpc, and de440s.bsp (NAIF's generic planetary
// ephemeris, which covers the present; it is not one of the test fixtures) in
// the directory named by SPICE_LITE_KERNELS. Prints what the sequence should
// do, computed with CSPICE, to compare with what it does.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSpiceEngine } from 'cspice-wasm';
import { slice } from '../../tools/slicer.mjs';

const [out, startArg, untilArg] = process.argv.slice(2);
if (!out) { console.error('usage: node examples/fprime/make-live-blob.mjs <out.slb> [startUtc] [secondsUntilSunrise]'); process.exit(2); }
const kernelDir = process.env.SPICE_LITE_KERNELS;
const kernels = ['naif0012.tls', 'pck00011.tpc', 'de440s.bsp'];
const start = new Date(startArg ?? Date.now());
start.setUTCMilliseconds(0);
const until = Number(untilArg ?? 150);
const iso = (d) => d.toISOString().slice(0, 19);
const windowStart = new Date(start.getTime() - 3600e3), windowStop = new Date(start.getTime() + 3 * 86400e3);

const spice = await createSpiceEngine();
for (const k of kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
const DEG = 180 / Math.PI;
// The Sun as seen from the Earth's center in the Earth's body-fixed frame.
const sun = async (et) => { const p = (await spice.spkpos('SUN', et, 'IAU_EARTH', 'NONE', 'EARTH')).position; return [p.x, p.y, p.z]; };
const etRise = (await spice.str2et(iso(start))) + until;
const s = await sun(etRise), r = Math.hypot(...s);
const dec = Math.asin(s[2] / r), lonSun = Math.atan2(s[1], s[0]);
// On the equator, sin(elevation) = cos(declination) cos(longitude east of the
// subsolar point); west of that point it is morning and the Sun is rising.
// (The Sun is far enough that its parallax, 9 arcseconds, moves the crossing
// by well under a second.)
const lonDeg = ((lonSun - Math.acos(Math.sin(10 / DEG) / Math.cos(dec))) * DEG + 540) % 360 - 180;

const config = {
  name: 'live',
  kernels,
  window: { start: iso(windowStart), stop: iso(windowStop) },
  bodies: [{ id: 399, parent: null, radiiFrom: 'EARTH' }, { id: 10, parent: 399, interval: 86400, degree: 10, radiiFrom: 'SUN' }],
  orient: [{ body: 399, frame: 'IAU_EARTH', interval: 86400, degree: 3 }],
  geodeticSites: true,
  sites: [{ id: 2, body: 399, lonDeg, latDeg: 0 }],
  time: [{ base: 2, unix: true, maxErrorSeconds: 1e-3 }],
};
const { blob, report } = await slice(config, kernelDir, kernelDir);
writeFileSync(out, blob);

// The elevation the sequence should report at a given Unix second: the site's
// geodetic up against the Sun's direction from the site, by CSPICE.
const site = report.sites[0].position, up = [Math.cos(lonDeg / DEG), Math.sin(lonDeg / DEG), 0];
const elevation = async (unix) => {
  const p = await sun(await spice.str2et(iso(new Date(unix * 1000))));
  const d = p.map((v, k) => v - site[k]);
  return Math.asin((d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / Math.hypot(...d)) * DEG;
};
const unix0 = start.getTime() / 1000;
console.log(`${out}: ${blob.length} bytes; window ${config.window.start} to ${config.window.stop} UTC; site 2 at longitude ${lonDeg.toFixed(4)} degrees on the equator`);
console.log(`by CSPICE the Sun is at ${(await elevation(unix0)).toFixed(2)} degrees at ${iso(start)} UTC (Unix ${unix0}) and passes 10 degrees about ${until} s later`);
console.log(JSON.stringify({ unixStart: unix0, lonDeg, expected: Object.fromEntries(await Promise.all([0, 60, 120, 180, 240, 300].map(async (t) => [unix0 + t, Number((await elevation(unix0 + t)).toFixed(2))]))) }));
process.exit(0);
