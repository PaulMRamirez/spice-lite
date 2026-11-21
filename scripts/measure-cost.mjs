// Tier D, cost: runs spice-lite inside NASA's SpaceWasm interpreter and counts the
// interpreter instructions each call executes, then checks the counts against the
// budgets in SPEC.md. Writes build/cost.json and prints a table.
//
//   node scripts/measure-cost.mjs [--update-doc]
//
// Needs cargo (to build bench/spacewasm-host) and the WebAssembly toolchain. The
// instruction is SpaceWasm's IR instruction, the unit its fuel counts; one F Prime
// WasmSequencer slice is 1,000 of them by default.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toHex = (d) => { const f = new Float64Array([d]); return new BigUint64Array(f.buffer)[0].toString(16).padStart(16, '0'); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });

mkdirSync(resolve(root, 'build'), { recursive: true });
const blobPath = resolve(root, 'test/blobs/cassini-soi.slb');
const blob = readFileSync(blobPath);
const report = JSON.parse(readFileSync(resolve(root, 'test/blobs/cassini-soi.report.json'), 'utf8'));

// A variant of the module with room for the 90 KB test blob. Memory size does not
// change what the code executes.
const benchWasm = resolve(root, 'build/spice_lite.bench.wasm');
run('bash', [resolve(root, 'scripts/build-wasm.sh')], { env: { ...process.env, WASM_OUT: benchWasm, WASM_INITIAL_MEMORY: String(4 * 65536) } });

const [w0] = report.windowEt;
const sc = report.ephem.find((s) => s.target === -82);
const tNat = w0 + 9.3 * 86400;        // a time inside every natural-body segment
const tSc = sc.tStart + 40000.5;      // a time inside the spacecraft segment, clear of its start
const zeros = Array(6).fill(toHex(1234.5)).join(' ');
const cases = [
  ['init 0', 'lite_init, checksum verified (90 KB blob)', null],
  ['init 1', 'lite_init, checksum skipped', null],
  ['host2et 3 100 500000', 'lite_host2et', 'time'],
  ['fwtime 00030000000064000001f4', 'lite_fwtime2et', 'time'],
  [`state 301 3 ${toHex(tNat)} 0`, 'lite_state, one segment (Moon from Earth-Moon barycenter), geometric', 'none1'],
  [`state 301 399 ${toHex(tNat)} 0`, 'lite_state, two segments (Moon from Earth), geometric', 'none'],
  [`state 10 399 ${toHex(tNat)} 0`, 'lite_state, three segments (Sun from Earth), geometric', 'none'],
  [`state 10 399 ${toHex(tNat)} 1`, 'lite_state, Sun from Earth, light time', 'lts'],
  [`state 10 399 ${toHex(tNat)} 2`, 'lite_state, Sun from Earth, light time and stellar aberration', 'lts'],
  [`state 301 399 ${toHex(tNat)} 2`, 'lite_state, Moon from Earth, light time and stellar aberration', 'lts'],
  [`state -82 6 ${toHex(tSc)} 0`, 'lite_state, spacecraft from Saturn barycenter (predicted), geometric', 'none1'],
  [`state 399 -82 ${toHex(tSc)} 2`, 'lite_state, Earth from spacecraft, light time and stellar aberration', 'lts'],
  [`orient 301 ${toHex(tNat)}`, 'lite_orient, Moon', null],
  [`siteview 1 10 ${toHex(tNat)} 0`, 'lite_site_view, Sun from a lunar site', null],
  [`setstate -82 6 ${toHex(tSc)} ${zeros} ${toHex(30)}`, 'lite_set_state', null],
  [`state -82 6 ${toHex(tSc + 5)} 0`, 'lite_state, spacecraft from Saturn barycenter (supplied), geometric', 'none1'],
  [`state -82 399 ${toHex(tSc + 5)} 0`, 'lite_state, spacecraft from Earth (supplied), geometric', 'none'],
  [`gap ${toHex(tSc + 5)}`, 'lite_state_gap', null],
  ['clearstate', 'lite_clear_state', null],
];
const hostDir = resolve(root, 'bench/spacewasm-host');
run('cargo', ['build', '--release', '--locked', '--quiet'], { cwd: hostDir });
const hostBin = resolve(hostDir, 'target/release/spice-lite-spacewasm-host');
const fmt = (n) => n.toLocaleString('en-US');
const failures = [];

async function measure(wasm, blobFile, queryList, tag) {
  const { exports: x } = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasm)), {});
  const at = (x.__heap_base.value + 7) & ~7;
  const qp = resolve(root, `build/cost.${tag}.queries`);
  writeFileSync(qp, queryList.map((c) => c[0]).join('\n') + '\n');
  const text = run(hostBin, ['--module', wasm, '--blob', blobFile, '--base', String(at), '--queries', qp]);
  const parsed = text.trim().split('\n').map((l) => JSON.parse(l));
  const rows = parsed.filter((l) => l.query).map((l, i) => ({ label: queryList[i][1], budget: queryList[i][2], status: l.status, instructions: l.instructions, slices: Math.ceil(l.instructions / 1000) }));
  for (const r of rows) if (r.status !== 0) failures.push(`${tag}: ${r.label}: status ${r.status}`);
  return { load: parsed[0].load, rows, base: at };
}
const tableOf = (rows) => ['| Call | Instructions | Slices of 1,000 |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.label} | ${fmt(r.instructions)} | ${fmt(r.slices)} |`)].join('\n');

// 1. Every call, on the large test blob.
const full = await measure(benchWasm, blobPath, cases, 'full');
// Ceilings from SPEC.md, in instructions: time conversion, a geometric state over one
// segment, a geometric state over up to three segments, and a corrected state.
const budgets = { time: 500, none1: 2500, none: 6000, lts: 15000 };
for (const r of full.rows) if (r.budget && r.instructions > budgets[r.budget]) failures.push(`${r.label}: ${r.instructions} instructions, ceiling ${budgets[r.budget]}`);

// 2. The flight-shaped case: the shipped one-page module with the small blob.
const shipped = resolve(root, 'build/spice_lite.wasm');
run('bash', [resolve(root, 'scripts/build-wasm.sh')]);
const smallPath = resolve(root, 'test/blobs/sun-earth-moon.slb');
const small = readFileSync(smallPath);
const smallReport = JSON.parse(readFileSync(resolve(root, 'test/blobs/sun-earth-moon.report.json'), 'utf8'));
const tS = smallReport.windowEt[0] + 9.3 * 86400;
const flight = await measure(shipped, smallPath, [
  ['init 0', 'lite_init, checksum verified (13 KB blob)', null],
  ['init 1', 'lite_init, checksum skipped', null],
  ['host2et 3 100 500000', 'lite_host2et', null],
  [`state 301 399 ${toHex(tS)} 0`, 'lite_state, Moon from Earth, geometric', null],
  [`state 10 399 ${toHex(tS)} 2`, 'lite_state, Sun from Earth, light time and stellar aberration', null],
  [`orient 301 ${toHex(tS)}`, 'lite_orient, Moon', null],
  [`siteview 1 10 ${toHex(tS)} 0`, 'lite_site_view, Sun from a lunar site', null],
], 'flight');
if (flight.load.guest_memory_bytes !== 65536) failures.push(`the shipped module has ${flight.load.guest_memory_bytes} bytes of memory, not one page`);
const pageUse = { heapBase: flight.base, blobBytes: small.length, end: flight.base + small.length, free: 65536 - (flight.base + small.length) };

// 3. The checksum table options, on the small blob.
const crcRows = [];
for (const tables of [0, 1, 4]) {
  const wasm = resolve(root, `build/spice_lite.crc${tables}.wasm`);
  run('bash', [resolve(root, 'scripts/build-wasm.sh')], { env: { ...process.env, WASM_OUT: wasm, LITE_CRC_TABLES: String(tables) } });
  const m = await measure(wasm, smallPath, [['init 0', 'init', null], ['init 1', 'skip', null]], `crc${tables}`);
  const crcOnly = m.rows[0].instructions - m.rows[1].instructions;
  crcRows.push({ tables, tableBytes: tables === 0 ? 64 : tables * 1024, moduleBytes: m.load.module_bytes, instructions: m.rows[0].instructions, perByte: crcOnly / (small.length - 16), slices: m.rows[0].slices });
}
const crcTable = ['| LITE_CRC_TABLES | Table size | Module size | Instructions per blob byte | lite_init on the 13 KB blob | Slices |', '| --- | --- | --- | --- | --- | --- |',
  ...crcRows.map((r) => `| ${r.tables}${r.tables === 1 ? ' (default)' : ''} | ${fmt(r.tableBytes)} bytes | ${fmt(r.moduleBytes)} bytes | ${r.perByte.toFixed(1)} | ${fmt(r.instructions)} | ${fmt(r.slices)} |`)].join('\n');

// 4. Sub-points and occultation, on the two geometry blobs (no ceilings set yet).
const eclPath = resolve(root, 'test/blobs/eclipses.slb');
const eclW0 = JSON.parse(readFileSync(resolve(root, 'test/blobs/eclipses.report.json'), 'utf8')).windowEt[0];
const soiW0 = JSON.parse(readFileSync(resolve(root, 'test/blobs/saturn-soi.report.json'), 'utf8')).windowEt[0];
const tE = eclW0 + 5.2 * 86400, tLunar = eclW0 + 15.13 * 86400, tSolar = eclW0 + 1.125 * 86400, tSoi = soiW0 + 15.9 * 3600;
const placed = (x, y, z) => `${[x, y, z, 0, 0, 0].map(toHex).join(' ')} ${toHex(30)}`;
const geoEcl = await measure(benchWasm, eclPath, [
  ['init 1', 'lite_init, checksum skipped', null],
  [`subpoint 301 399 ${toHex(tE)}`, 'lite_sub_point, Moon (a sphere) from Earth', null],
  [`subpoint 399 301 ${toHex(tE)}`, 'lite_sub_point, Earth (a spheroid) from the Moon', null],
  [`subpoint 4 399 ${toHex(tE)}`, 'lite_sub_point, triaxial stand-in from Earth, three segments', null],
  [`setstate -900 399 ${toHex(tE)} ${placed(4000, -5000, 3500)}`, 'lite_set_state', null],
  [`subpoint 399 -900 ${toHex(tE)}`, 'lite_sub_point, Earth from a supplied spacecraft state 900 km up', null],
  [`setstate -900 4 ${toHex(tE)} ${placed(9, -14, 12)}`, 'lite_set_state', null],
  [`subpoint 4 -900 ${toHex(tE)}`, 'lite_sub_point, triaxial stand-in from a supplied spacecraft state 10 km up', null],
  [`occulted 10 301 -900 ${toHex(tE)}`, 'lite_occulted, Sun by the Moon from a supplied spacecraft state (none)', null],
  [`occulted 399 301 10 ${toHex(tSolar)}`, 'lite_occulted, Earth by the Moon from the Sun (partial)', null],
  [`occulted 10 399 301 ${toHex(tLunar)}`, 'lite_occulted, Sun by Earth from the Moon (full)', null],
  [`occulted 399 10 301 ${toHex(tLunar)}`, 'lite_occulted, Earth by the Sun from the Moon (the Sun is behind)', null],
], 'geometry-eclipses');
const geoSoi = await measure(benchWasm, resolve(root, 'test/blobs/saturn-soi.slb'), [
  ['init 1', 'lite_init, checksum skipped', null],
  [`subpoint 699 -82 ${toHex(tSoi)}`, 'lite_sub_point, Saturn (a spheroid) from Cassini (predicted)', null],
  [`occulted 10 699 -82 ${toHex(tSoi)}`, 'lite_occulted, Sun by Saturn from Cassini (full)', null],
], 'geometry-soi');
const geometryRows = [...geoEcl.rows, ...geoSoi.rows].filter((r) => /sub_point|occulted/.test(r.label));

const result = { spacewasm: '0.8.0-rc.3', full, flight, pageUse, crc: crcRows, budgets, geometry: geometryRows };
writeFileSync(resolve(root, 'build/cost.json'), JSON.stringify(result, null, 2) + '\n');
const tables = { full: tableOf(full.rows), flight: tableOf(flight.rows), crc: crcTable, geometry: tableOf(geometryRows) };

// 5. Time conversion against the number of TIME pieces. lite_host2et finds its
// piece by binary search, so its cost follows the number of probes, which is at
// most 15 for the largest table a 1 MiB blob can hold. Tables of up to 4,096
// pieces (13 probes) are held to the time ceiling; the largest possible table
// is measured and reported but not held, because it sits right at the ceiling
// and compiler builds differ by a few percent. This block is self-contained: it
// has its own runner because some of its readings are meant to be out of
// coverage, and it adds its results to the objects above instead of changing
// how they are built.
{
  const { readTimeTable, withTimeTable } = await import('../test/time-table.mjs');
  const split = (host) => { const u = Math.round(host * 1e6); return [Math.floor(u / 1e6), u % 1e6]; };
  // A module variant with room for a blob of the largest size the format allows.
  const bigWasm = resolve(root, 'build/spice_lite.bench-time.wasm');
  run('bash', [resolve(root, 'scripts/build-wasm.sh')], { env: { ...process.env, WASM_OUT: bigWasm, WASM_INITIAL_MEMORY: String(20 * 65536) } });
  const { exports: bx } = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(bigWasm)), {});
  const bigBase = (bx.__heap_base.value + 7) & ~7;
  const carrier = new Uint8Array(readFileSync(resolve(root, 'test/blobs/sclk-drift.slb')));
  const many = new Uint8Array(readFileSync(resolve(root, 'test/blobs/sclk-many.slb')));
  const clock = readTimeTable(many).filter((t) => t.base === 3);
  // Synthetic tables: n pieces of base 3, one every 100 host seconds, with a
  // piece of base 2 before them and one of base 5 after, so the search also has
  // to stop at the edges of a base.
  const synthetic = (n) => [{ base: 2, hostStart: 0, etStart: 0, rate: 1 },
    ...Array.from({ length: n - 2 }, (_, i) => ({ base: 3, hostStart: 1000 + 100 * i, etStart: 5e7 + 100 * i, rate: 1 + 1e-9 * (i % 7) })),
    { base: 5, hostStart: 0, etStart: 0, rate: 1 }];
  const largest = Math.floor(((1 << 20) - ((carrier.length + 7) & ~7)) / 32);
  const blobs = [
    ['sun-earth-moon (committed)', new Uint8Array(readFileSync(smallPath))],
    ['sclk-drift (committed; the synthetic drifting clock to a microsecond)', carrier],
    ['the first 26 clock pieces of sclk-many (30 days to 0.1 microseconds)', withTimeTable(carrier, clock.slice(0, 26), { fixCrc: false })],
    ['sclk-many (committed; 203 clock pieces and three of other bases)', many],
    ['synthetic table of 256 pieces (the slicer\'s default limit for one clock)', withTimeTable(carrier, synthetic(256), { fixCrc: false })],
    ['synthetic table of 4,096 pieces', withTimeTable(carrier, synthetic(4096), { fixCrc: false })],
    [`synthetic table of ${fmt(largest)} pieces (the most a 1 MiB blob holds)`, withTimeTable(carrier, synthetic(largest), { fixCrc: false })],
  ];
  const timeHeldTo = 4096; // pieces; larger tables are reported, not held
  const timeRows = [];
  for (const [k, [label, bytes]] of blobs.entries()) {
    const table = readTimeTable(bytes);
    // Readings: every piece's first reading and the reading a microsecond
    // before it (a sample of 256 pieces when there are more), a reading far past
    // the last piece of each base, and a time base the blob does not have.
    const step = Math.max(1, Math.floor(table.length / 256));
    const picked = table.filter((_, i) => i % step === 0 || i === table.length - 1);
    const queries = ['init 1'];
    for (const t of picked) {
      const [sec, usec] = split(t.hostStart);
      queries.push(`host2et ${t.base} ${sec} ${usec}`);
      const before = sec * 1e6 + usec - 1;
      if (before >= 0) queries.push(`host2et ${t.base} ${Math.floor(before / 1e6)} ${before % 1e6}`);
    }
    for (const base of new Set(table.map((t) => t.base))) queries.push(`host2et ${base} 4294967295 999999`);
    queries.push('host2et 9 1000 0', 'host2et 0 1000 0');
    const bp = resolve(root, `build/cost.time-${k}.slb`), qp = resolve(root, `build/cost.time-${k}.queries`);
    writeFileSync(bp, bytes);
    writeFileSync(qp, queries.join('\n') + '\n');
    const out = run(hostBin, ['--module', bigWasm, '--blob', bp, '--base', String(bigBase), '--queries', qp]).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.query);
    if (out[0].status !== 0) { failures.push(`time: ${label}: lite_init status ${out[0].status}`); continue; }
    const calls = out.slice(1);
    // Only "converted" and "out of coverage" are expected of these readings.
    if (calls.some((l) => l.status !== 0 && l.status !== 1)) failures.push(`time: ${label}: an unexpected status`);
    const counts = calls.map((l) => l.instructions);
    const row = { label, pieces: table.length, readings: calls.length, converted: calls.filter((l) => l.status === 0).length, fewest: Math.min(...counts), most: Math.max(...counts), held: table.length <= timeHeldTo };
    if (row.held && row.most > budgets.time) failures.push(`lite_host2et with ${row.pieces} TIME pieces (${label}): ${row.most} instructions, ceiling ${budgets.time}`);
    timeRows.push(row);
  }
  result.time = timeRows;
  writeFileSync(resolve(root, 'build/cost.json'), JSON.stringify(result, null, 2) + '\n');
  if (!timeRows.some((r) => r.held && r.pieces >= 200)) failures.push('time: no table of 200 or more pieces was measured against the ceiling');
  tables.time = ['| TIME pieces | Blob | Readings | Fewest instructions | Most instructions | Held to 500 |', '| --- | --- | --- | --- | --- | --- |',
    ...timeRows.map((r) => `| ${fmt(r.pieces)} | ${r.label} | ${fmt(r.readings)} | ${fmt(r.fewest)} | ${fmt(r.most)} | ${r.held ? 'yes' : 'no'} |`)].join('\n');
}

console.log(`module ${fmt(full.load.module_bytes)} bytes, IR ${fmt(full.load.ir_bytes)} bytes, interpreter heap ${fmt(full.load.heap_bytes)} bytes, stack ${fmt(full.load.stack_words)} words`);
console.log(tables.full + '\n');
console.log(`one page: module data and stack end at byte ${fmt(pageUse.heapBase)}, the blob ends at ${fmt(pageUse.end)}, ${fmt(pageUse.free)} bytes free`);
console.log(tables.flight + '\n');
console.log(tables.crc + '\n');
console.log(tables.geometry);
console.log('\n' + tables.time);
if (process.argv.includes('--update-doc')) {
  const docPath = resolve(root, 'docs/cost-measurements.md');
  let doc = readFileSync(docPath, 'utf8');
  for (const [key, table] of Object.entries(tables)) {
    const [a, b] = [`<!-- ${key}-table:start -->`, `<!-- ${key}-table:end -->`];
    if (!doc.includes(a) || !doc.includes(b)) throw new Error(`docs/cost-measurements.md lacks the ${key} table markers`);
    doc = doc.slice(0, doc.indexOf(a) + a.length) + '\n' + table + '\n' + doc.slice(doc.indexOf(b));
  }
  writeFileSync(docPath, doc);
}
if (failures.length) {
  console.error('\nover a ceiling or failed:\n  ' + failures.join('\n  '));
  process.exit(1);
}
