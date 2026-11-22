// Helpers for tests of the TIME section and the search in lite_host2et: read a
// blob's TIME entries, write a blob whose TIME section is any table the test
// likes (sorted or not), and convert a reading the way the library did before it
// searched, by scanning every entry. The scan is the reference: on every table
// the library accepts, the search must return the same status and the same bits.

const HEADER = 64, DIR_ENTRY = 16, TIME_ENTRY = 32, SEC_TIME = 1;

function crc32(bytes, from) {
  let crc = 0xffffffff;
  for (let i = from; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

// Fletcher-32 over 16-bit little-endian words, for a blob whose header says it
// carries that sum (flag bit 4).
function fletcher32(bytes, from) {
  let a = 0, b = 0;
  for (let i = from; i < bytes.length; i += 2) {
    a = (a + bytes[i] + 256 * (bytes[i + 1] ?? 0)) % 65535;
    b = (b + a) % 65535;
  }
  return (b * 65536 + a) >>> 0;
}

const viewOf = (blob) => new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

function timeDirectory(blob) {
  const v = viewOf(blob);
  const n = v.getUint16(20, true);
  for (let i = 0; i < n; i++) {
    const at = HEADER + i * DIR_ENTRY;
    if (v.getUint16(at, true) === SEC_TIME) return { at, offset: v.getUint32(at + 4, true), count: v.getUint32(at + 12, true) };
  }
  return null;
}

// The TIME entries of a blob, in file order: { base, hostStart, etStart, rate,
// maxErr }, with context when the blob selects by context (header flag bit 2)
// and gap: true on an entry marked as one.
export function readTimeTable(blob) {
  const dir = timeDirectory(blob);
  if (!dir) return [];
  const v = viewOf(blob), out = [];
  for (let i = 0; i < dir.count; i++) {
    const o = dir.offset + i * TIME_ENTRY;
    const t = { base: v.getUint16(o, true), hostStart: v.getFloat64(o + 8, true), etStart: v.getFloat64(o + 16, true), rate: v.getFloat64(o + 24, true), maxErr: v.getFloat32(o + 4, true) };
    if (v.getUint32(16, true) & 4) t.context = v.getUint8(o + 2);
    if (v.getUint8(o + 3) & 1) t.gap = true;
    out.push(t);
  }
  return out;
}

// A copy of the blob whose TIME section is the given entries, written in the
// order given with no sorting and no checks. The new table is appended (the old
// one stays where it was, unreferenced), the directory entry and the total
// length are rewritten, and the CRC is recomputed unless fixCrc is false, in
// which case the caller loads the blob with the checksum skipped. The blob must
// already have a TIME section, and the blob identifier is left as it was. The
// header's flag bits 2 and 3 are set to match the entries (any context, any
// gap) unless headerFlags gives the whole flag word.
export function withTimeTable(blob, entries, { fixCrc = true, headerFlags } = {}) {
  const dir = timeDirectory(blob);
  if (!dir) throw new Error('the blob has no TIME section to replace');
  const start = (blob.length + 7) & ~7;
  const out = new Uint8Array(start + entries.length * TIME_ENTRY);
  out.set(blob);
  const v = viewOf(out);
  entries.forEach((t, i) => {
    const o = start + i * TIME_ENTRY;
    v.setUint16(o, t.base, true);
    v.setUint8(o + 2, t.context ?? 0);
    v.setUint8(o + 3, t.gap ? 1 : 0);
    v.setFloat32(o + 4, t.maxErr ?? 0, true);
    v.setFloat64(o + 8, t.hostStart, true);
    v.setFloat64(o + 16, t.etStart, true);
    v.setFloat64(o + 24, t.rate, true);
  });
  v.setUint32(dir.at + 4, start, true);
  v.setUint32(dir.at + 8, entries.length * TIME_ENTRY, true);
  v.setUint32(dir.at + 12, entries.length, true);
  v.setUint32(8, out.length, true);
  v.setUint32(16, headerFlags ?? ((v.getUint32(16, true) & ~12) | (entries.some((t) => t.context !== undefined) ? 4 : 0) | (entries.some((t) => t.gap) ? 8 : 0)), true);
  if (fixCrc) v.setUint32(12, (v.getUint32(16, true) & 16 ? fletcher32 : crc32)(out, 16), true);
  return out;
}

// True when the entries are in the order the format requires: ascending by key
// (the time base, with the context above it where there is one), then by
// host_start, with no two pieces of one key starting together.
const keyOf = (t) => t.base + 65536 * (t.context ?? 0);
export const timeSorted = (entries) => entries.every((t, i) => i === 0 ||
  keyOf(t) > keyOf(entries[i - 1]) || (keyOf(t) === keyOf(entries[i - 1]) && t.hostStart > entries[i - 1].hostStart));

// lite_host2et as it was before the search: every entry is scanned, and the
// piece is the one of this base (and context, where the entries carry one;
// the caller then passes it in bits 16 to 23 of timeBase) with the latest
// host_start not after the reading. A gap answers out of coverage. Returns
// { status, et } with the library's status codes.
export function hostScan(entries, timeBase, seconds, useconds) {
  if (useconds >= 1000000) return { status: 6 };
  const host = seconds + useconds * 1.0e-6;
  let best = null;
  const mask = entries.some((e) => e.context !== undefined) ? 0xffffff : 0xffff;
  for (const e of entries) {
    if (keyOf(e) === (timeBase & mask) && e.hostStart <= host && (best === null || e.hostStart >= best.hostStart)) best = e;
  }
  if (best === null || best.gap) return { status: 1 };
  return { status: 0, et: best.etStart + best.rate * (host - best.hostStart) };
}
