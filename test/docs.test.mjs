// The documents that show use stay true: the example they quote builds and
// runs, the blob the walkthrough cuts comes out as the walkthrough says, and
// every link between the documents leads somewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { root } from './harness.mjs';

const cc = process.env.NATIVE_CC ?? 'cc';
const haveCc = spawnSync(cc, ['--version']).status === 0;

test('examples/native/tour.c builds and every call behaves as docs/api.md says', { skip: !haveCc && `no C compiler (${cc})` }, () => {
  mkdirSync(resolve(root, 'build'), { recursive: true });
  const exe = resolve(root, 'build/tour');
  execFileSync(cc, ['-std=c99', '-O2', '-ffp-contract=off', '-Wall', '-Wextra', '-Werror', `-I${resolve(root, 'include')}`,
    '-o', exe, resolve(root, 'examples/native/tour.c'), resolve(root, 'src/spice_lite.c'), '-lm']);
  const out = execFileSync(exe, [resolve(root, 'test/blobs/cassini-soi.slb'), resolve(root, 'test/blobs/saturn-soi.slb')], { encoding: 'utf8' });
  assert.match(out, /tour complete\n$/);
  assert.doesNotMatch(out, /FAIL/);
  // docs/getting-started.md prints this output; it must be what the program prints.
  const doc = readFileSync(resolve(root, 'docs/getting-started.md'), 'utf8');
  for (const line of out.trim().split('\n')) assert.ok(doc.includes(line), `docs/getting-started.md does not show: ${line}`);
});

const config = JSON.parse(readFileSync(resolve(root, 'examples/getting-started/canberra.json'), 'utf8'));
const kernelDir = process.env.SPICE_LITE_KERNELS;
const haveKernels = kernelDir && config.kernels.every((k) => existsSync(resolve(kernelDir, k)));

test('the walkthrough configuration cuts the blob docs/getting-started.md describes', { skip: !haveKernels && 'SPICE_LITE_KERNELS is not set or lacks the kernels' }, async () => {
  const { slice } = await import('../tools/slicer.mjs');
  const { load } = await import('./harness.mjs');
  const { blob, report } = await slice(config, kernelDir);
  const doc = readFileSync(resolve(root, 'docs/getting-started.md'), 'utf8');
  assert.ok(doc.includes(`build/canberra.slb: ${blob.length} bytes`), `the walkthrough does not say ${blob.length} bytes`);
  for (const s of report.ephem) assert.ok(s.maxPosErr < 1e-6, `body ${s.target} is off by ${s.maxPosErr} km`);
  // The library accepts it and answers the walkthrough's question from it.
  const lib = await load(blob);
  assert.equal(lib.initStatus, 0);
  const t = lib.host2et(3, 80400, 0);
  assert.equal(t.status, 0);
  const view = lib.siteView(1, 10, t.et, 0);
  assert.equal(view.status, 0);
  assert.ok(Math.abs((view.el * 180) / Math.PI - 10.43) < 0.005, `elevation ${(view.el * 180) / Math.PI}`);
});

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens.
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
const anchorsOf = (text) => new Set(text.replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ''))));

test('every link between the documents resolves, anchors included', () => {
  const pages = ['README.md', 'SPEC.md', 'CHANGELOG.md', ...readdirSync(resolve(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  const broken = [];
  for (const page of pages) {
    const text = readFileSync(resolve(root, page), 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue; // an outside address
      const [path, anchor] = target.split('#');
      const file = path ? resolve(root, dirname(page), path) : resolve(root, page);
      if (!existsSync(file)) { broken.push(`${page}: ${target} (no such file)`); continue; }
      if (anchor && file.endsWith('.md') && !anchorsOf(readFileSync(file, 'utf8')).has(anchor)) broken.push(`${page}: ${target} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every guide links back to the documentation index, and the index lists every page', () => {
  const index = readFileSync(resolve(root, 'docs/README.md'), 'utf8');
  for (const f of readdirSync(resolve(root, 'docs')).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    assert.ok(index.includes(`(${f})`), `docs/README.md does not list ${f}`);
    assert.ok(readFileSync(resolve(root, 'docs', f), 'utf8').includes('](README.md)'), `docs/${f} does not link to the index`);
  }
});
