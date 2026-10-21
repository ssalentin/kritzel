// Per-thing sprites: strict grid parsing, one fix, atomic files, and a deterministic 32x32 PNG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, parseGrid, validatePng, makeSprite, spritePrompt } from '../scripts/thing_sprite.mjs';
import { DRAGON, TOWER, TREE } from '../scripts/sprite-examples.mjs';
process.env.KRITZEL_PROVIDER = 'claude';
delete process.env.KRITZEL_MODEL; delete process.env.KRITZEL_DRAFT_MODEL;

test('the three worked examples are valid 32x32 grids', () => {
  for (const [name, grid] of [['dragon', DRAGON], ['tower', TOWER], ['tree', TREE]]) {
    const rows = parseGrid(grid.join('\n'));
    assert.equal(rows.length, 32, name);
    assert.ok(rows.every(r => r.length === 32), name);
  }
});

test('the prompt insists on the description\'s signature features and exact grid', () => {
  const prompt = spritePrompt({ name: 'Hexe', drawing: 'a witch riding on a broom', kind: 'actor', move: 'fly' });
  assert.match(prompt, /Drawing is the subject/);
  assert.match(prompt, /witch riding a broom/);
  assert.match(prompt, /exactly 32 lines of exactly 32 characters/);
  assert.match(prompt, /\. = transparent/);
});

test('a grid must have 32 exact rows, known keys, 15-90% coverage and more than one tone', () => {
  assert.throws(() => parseGrid(DRAGON.slice(1).join('\n')), /exactly 32 rows/);
  assert.throws(() => parseGrid(DRAGON.map((r, i) => i ? r : r.slice(1)).join('\n')), /row 1 has 31/);
  assert.throws(() => parseGrid(DRAGON.map((r, i) => i ? r : 'q' + r.slice(1)).join('\n')), /unknown key "q"/);
  assert.throws(() => parseGrid(Array(32).fill('.'.repeat(32)).map((r, i) => i === 16 ? 'g' + '.'.repeat(31) : r).join('\n')), /at least 15%/);
  assert.throws(() => parseGrid(Array(32).fill('g'.repeat(32)).join('\n')), /at most 90%/);
  assert.throws(() => parseGrid(Array(32).fill(0).map((_, i) => i < 16 ? 'g'.repeat(32) : '.'.repeat(32)).join('\n')), /more than one palette key/);
});

const fakeBuild = (calls) => async ({ source, base, outDir }) => {
  calls.push(base);
  mkdirSync(outDir, { recursive: true });
  const sourcePath = join(outDir, base + '.px.js');
  const png = join(outDir, base + '.png');
  writeFileSync(sourcePath, source);
  writeFileSync(png, 'fake-png');
  return { source: sourcePath, png, bytes: 8, ms: 1 };
};

test('a bad grid gets exactly one fix, then writes the sprite and report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-sprite-fix-'));
  try {
    const calls = [];
    let asked = 0;
    const ask = async () => ({ text: asked++ ? DRAGON.join('\n') : 'not a grid', model: 'fake', seconds: 0.1, cost: 0.001 });
    const r = await makeSprite({ name: 'Drache', drawing: 'a dragon', kind: 'actor', move: 'fly',
      file: 'drache.js', outDir: join(dir, 'out'), reportDir: join(dir, 'reports'), ask, build: fakeBuild(calls) });
    assert.equal(asked, 2);
    assert.deepEqual(calls, ['drache']);
    assert.equal(r.fixed, true);
    assert.ok(existsSync(join(dir, 'out', 'drache.png')));
    assert.ok(existsSync(join(dir, 'out', 'drache.px.js')));
    const report = JSON.parse(readFileSync(join(dir, 'reports', 'drache.sprite.json'), 'utf8'));
    assert.equal(report.fixed, true);
    assert.equal(report.calls.length, 2);
    assert.equal(report.error, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two bad grids fail visibly and write no sprite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-sprite-bad-'));
  try {
    const calls = [];
    let asked = 0;
    const ask = async () => ({ text: 'still not a grid ' + asked++, model: 'fake', seconds: 0.1, cost: 0.001 });
    await assert.rejects(makeSprite({ name: 'Drache', file: 'drache.js', outDir: join(dir, 'out'),
      reportDir: join(dir, 'reports'), ask, build: fakeBuild(calls) }), /rejected after one fix/);
    assert.equal(asked, 2);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(dir, 'out')), false);
    const report = JSON.parse(readFileSync(join(dir, 'reports', 'drache.sprite.json'), 'utf8'));
    assert.match(report.error, /rejected after one fix/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a build failure leaves no partial source or PNG', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-sprite-half-'));
  try {
    const ask = async () => ({ text: DRAGON.join('\n'), model: 'fake', seconds: 0.1, cost: 0 });
    const build = async () => { throw new Error('claude-pxl exploded'); };
    await assert.rejects(makeSprite({ name: 'Drache', file: 'drache.js', outDir: join(dir, 'out'),
      reportDir: join(dir, 'reports'), ask, build }), /sprite build failed/);
    assert.equal(existsSync(join(dir, 'out', 'drache.png')), false);
    assert.equal(existsSync(join(dir, 'out', 'drache.px.js')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real claude-pxl build is 32x32, palette-only and byte-identical', async t => {
  if (!existsSync(join(ROOT, '.kritzel', 'claude-pxl', 'bin', 'pxl.js'))) return t.skip('claude-pxl is not set up');
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-sprite-png-'));
  try {
    const ask = async () => ({ text: DRAGON.join('\n'), model: 'fake', seconds: 0.1, cost: 0 });
    const one = await makeSprite({ name: 'Drache', file: 'drache.js', outDir: join(dir, 'one'), reportDir: join(dir, 'r'), ask });
    const two = await makeSprite({ name: 'Drache', file: 'drache.js', outDir: join(dir, 'two'), reportDir: join(dir, 'r'), ask });
    assert.deepEqual(validatePng(one.png), [32, 32]);
    assert.deepEqual(readFileSync(one.png), readFileSync(two.png));
    assert.deepEqual(readFileSync(one.source), readFileSync(two.source));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
