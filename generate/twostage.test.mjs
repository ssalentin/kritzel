// Two stages: a draft written first, the final model's build replaces it in place (fake claude, test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
Object.assign(process.env, { KRITZEL_DRAFT_MODEL: 'claude-haiku-5-5', KRITZEL_MODEL: 'claude-sonnet-5-5', KRITZEL_FINAL_RETRY_S: '0.3', KRITZEL_THINGS_LINGER_MS: '100' });
const { processFrame } = await import('./generate.mjs');
const example = readFileSync(join(import.meta.dirname, 'examples', 'schnecke.js'), 'utf8');

let lists = [], listsAtEnd = 0;
async function run({ final, slow = null, meanwhile = null, onLater = () => {}, after = 0 }) {
  lists = [];
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-two-'));
  for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
  const frame = join(dir, '20261017-120000.jpg');
  execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
  writeFileSync(join(dir, 'draft.txt'), `SEEN: [{"de": "eine Schnecke", "en": "a snail", "den": "die Schnecke", "the": "the snail", "name_en": "Snail"}]\n### NEW\n${example}`);
  writeFileSync(join(dir, 'final.txt'), final);
  process.env.FAKE_CLAUDE_BY_MODEL = JSON.stringify({ 'claude-haiku-5-5': join(dir, 'draft.txt'), 'claude-sonnet-5-5': join(dir, 'final.txt') });
  if (slow) process.env.FAKE_CLAUDE_SLOW = slow; else delete process.env.FAKE_CLAUDE_SLOW;
  try {
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [100, 100, 200, 200], onLater, onProgress: p => { if (p.things) lists.push(p.things); } });
    const draft = readFileSync(join(dir, 'things', r.written[0].file), 'utf8');
    if (meanwhile) meanwhile(join(dir, 'things', r.written[0].file));
    await r.finalsDone;
    await new Promise(ok => setTimeout(ok, 50)); listsAtEnd = lists.length;   // after the frame's own list is done
    if (after) await new Promise(ok => setTimeout(ok, after));                // a retried final comes later
    const saved = JSON.parse(readFileSync(join(dir, 'reports', '20261017-120000.json'), 'utf8'));
    return { r, saved, draft, now: readFileSync(join(dir, 'things', r.written[0].file), 'utf8'), files: readdirSync(join(dir, 'things')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the final replaces the draft in its file, keeping its name and actor id', async () => {
  const final = example.replace(/0x[0-9a-f]{6}/i, '0x123456').replace(/name: 'Schnecke'/g, "name: 'Große Schnecke'");
  const { r, saved, draft, now, files } = await run({ final });
  assert.match(draft, /\(claude-haiku-5-5\)/);
  assert.match(draft, /export const meta = \{ draft: true,/);                // the draft says so, for the viewer's pencil look
  assert.ok(!/draft: true/.test(now));                                   // the final does not
  assert.match(now, /\(claude-sonnet-5-5\)/);
  assert.match(now, /0x123456/);
  assert.ok(!/Große Schnecke/.test(now) && /name: 'Schnecke'/.test(now));        // the book knows it as Schnecke
  assert.deepEqual(files.filter(f => f.endsWith('.js')), ['schnecke.js']);         // replaced, not added
  assert.equal(saved.finals[0].model, 'claude-sonnet-5-5');
  assert.equal(typeof saved.timing.finalsDone, 'number');
  assert.equal(r.written[0].model, 'claude-haiku-5-5');
});

test('a final that fails is tried once more; failing again, the draft stands as a plain thing', async () => {
  const { saved, draft, now } = await run({ final: 'export const meta = { name: "x" };', after: 1500 });
  assert.deepEqual(saved.finals.map(f => [f.kept, f.attempt]), [['draft', 1], ['draft', 2]]);
  assert.match(draft, /draft: true/);
  assert.equal(now, draft.replace(' draft: true,', ''));                   // never 'unfinished' for good
  assert.ok(!lists.slice(listsAtEnd).some(l => l.length));                 // the late retry put no old list back
});

test('a thing changed meanwhile keeps the change: the stale final is dropped', async () => {
  const { saved, now } = await run({ final: example.replace(/0x[0-9a-f]{6}/i, '0x123456'), slow: 'claude-sonnet-5-5:800',
    meanwhile: f => writeFileSync(f, example.replace('Schnecke', 'Schnecke') + '\n// a child changed it\n') });
  assert.match(now, /a child changed it/);
  assert.equal(saved.finals[0].dropped, 'changed meanwhile');
});

test('a final built somewhere else gets one fix to stand where the draft stands, or the draft stays', async () => {
  // the final moves the whole snail 3 units along x: its fix call (the same fake reply) is still off, so the draft stays
  const moved = example.replace(/world\.add\((\w+)\)/, (m, g) => `${g}.position.x += 3; world.add(${g})`);
  assert.notEqual(moved, example);
  const { saved, draft, now } = await run({ final: moved });
  assert.equal(now, draft);
  assert.equal(saved.finals[0].kept, 'draft');
  assert.match(saved.finals[0].problems.join(' '), /build it centred there/);
});

test('a final may split its draft: the first part replaces it, the others are new things', async () => {
  const stone = `export const meta = { name: 'Stein', drawing: 'a round stone', paper: { x: 0.3, y: 0.5 } };
export function build(ctx) {
  const { THREE, world, mat, shadowAll } = ctx;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.DodecahedronGeometry(0.5), mat(0x999999)));
  g.position.set(-1, 0.4, 0);
  shadowAll(g); world.add(g);
  return { actors: [], obstacles: [{ x: -1, z: 0, r: 0.5 }], spots: [] };
}`;
  let later = null;
  // a later frame writes its own stein.js while the final runs: the part must not overwrite it
  const { saved, now, files } = await run({ final: `### NEW\n${example.replace(/0x[0-9a-f]{6}/i, '0x123456')}\n### NEW\n${stone}`, slow: 'claude-sonnet-5-5:300',
    meanwhile: f => writeFileSync(join(f, '..', 'stein.js'), stone), onLater: x => { later = x; } });
  assert.match(now, /0x123456/);                                        // the draft's file holds the first part
  assert.deepEqual(files.filter(f => f.endsWith('.js')).sort(), ['schnecke.js', 'stein-2.js', 'stein.js']);
  assert.deepEqual(saved.finals[0].split, ['stein-2.js']);
  assert.equal(saved.written.find(w => w.file === 'stein-2.js').splitFrom, 'schnecke.js');
  assert.deepEqual(later.written.map(w => w.file), ['stein-2.js']);      // the watcher hears of it (dialogues)
  assert.equal(later.written[0].name, 'Stein 2');                        // a later frame's Stein is on disk: the part is Stein 2
});

test('the draft is asked for as an honest sketch; its final gets the plain question', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'kritzel-log-')), 'prompts.jsonl');
  process.env.FAKE_CLAUDE_LOG = log;
  try {
    await run({ final: example });
    const prompts = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).message.content.at(-1).text);
    assert.match(prompts[0], /honest sketch/);                          // the draft (first call)
    assert.match(prompts[0], /UPDATE section is built fully/);          // an UPDATE gets no final: never a sketch
    assert.ok(prompts.slice(1).every(p => !/honest sketch/.test(p)));     // the final
  } finally { delete process.env.FAKE_CLAUDE_LOG; }
});
