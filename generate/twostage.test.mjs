// Two stages: a draft written first, the final model's build replaces it in place (fake claude, test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
Object.assign(process.env, { KRITZEL_DRAFT_MODEL: 'claude-haiku-5-5', KRITZEL_MODEL: 'claude-sonnet-5-5' });
const { processFrame } = await import('./generate.mjs');
const example = readFileSync(join(import.meta.dirname, 'examples', 'schnecke.js'), 'utf8');

async function run({ final, slow = null, meanwhile = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-two-'));
  for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
  const frame = join(dir, '20261017-120000.jpg');
  execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
  writeFileSync(join(dir, 'draft.txt'), `SEEN: [{"de": "eine Schnecke", "en": "a snail", "den": "die Schnecke", "the": "the snail", "name_en": "Snail"}]\n### NEW\n${example}`);
  writeFileSync(join(dir, 'final.txt'), final);
  process.env.FAKE_CLAUDE_BY_MODEL = JSON.stringify({ 'claude-haiku-5-5': join(dir, 'draft.txt'), 'claude-sonnet-5-5': join(dir, 'final.txt') });
  if (slow) process.env.FAKE_CLAUDE_SLOW = slow; else delete process.env.FAKE_CLAUDE_SLOW;
  try {
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [100, 100, 200, 200] });
    const draft = readFileSync(join(dir, 'things', r.written[0].file), 'utf8');
    if (meanwhile) meanwhile(join(dir, 'things', r.written[0].file));
    await r.finalsDone;
    const saved = JSON.parse(readFileSync(join(dir, 'reports', '20261017-120000.json'), 'utf8'));
    return { r, saved, draft, now: readFileSync(join(dir, 'things', r.written[0].file), 'utf8'), files: readdirSync(join(dir, 'things')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the final replaces the draft in its file, keeping its name and actor id', async () => {
  const final = example.replace(/0x[0-9a-f]{6}/i, '0x123456').replace(/name: 'Schnecke'/g, "name: 'Große Schnecke'");
  const { r, saved, draft, now, files } = await run({ final });
  assert.match(draft, /\(claude-haiku-5-5\)/);
  assert.match(now, /\(claude-sonnet-5-5\)/);
  assert.match(now, /0x123456/);
  assert.ok(!/Große Schnecke/.test(now) && /name: 'Schnecke'/.test(now));        // the book knows it as Schnecke
  assert.deepEqual(files.filter(f => f.endsWith('.js')), ['schnecke.js']);         // replaced, not added
  assert.equal(saved.finals[0].model, 'claude-sonnet-5-5');
  assert.equal(typeof saved.timing.finalsDone, 'number');
  assert.equal(r.written[0].model, 'claude-haiku-5-5');
});

test('a final that fails its checks leaves the draft', async () => {
  const { saved, draft, now } = await run({ final: 'export const meta = { name: "x" };' });
  assert.equal(now, draft);
  assert.equal(saved.finals[0].kept, 'draft');
});

test('a thing changed meanwhile keeps the change: the stale final is dropped', async () => {
  const { saved, now } = await run({ final: example.replace(/0x[0-9a-f]{6}/i, '0x123456'), slow: 'claude-sonnet-5-5:800',
    meanwhile: f => writeFileSync(f, example.replace('Schnecke', 'Schnecke') + '\n// a child changed it\n') });
  assert.match(now, /a child changed it/);
  assert.equal(saved.finals[0].dropped, 'changed meanwhile');
});
