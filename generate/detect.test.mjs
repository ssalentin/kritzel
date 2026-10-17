// A new sheet: one call lists its drawings, then each is built by its own call (against a fake claude, test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
delete process.env.KRITZEL_MODEL; delete process.env.KRITZEL_DETECT_MODEL;
const { processFrame, parseList, slots } = await import('./generate.mjs');

const stone = `export const meta = { name: 'Stein', drawing: 'a round stone', paper: { x: 0.3, y: 0.5 } };
export function build(ctx) {
  const { THREE, world, mat, shadowAll } = ctx;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.DodecahedronGeometry(0.5), mat(0x999999)));
  g.position.set(-2, 0.4, 0);
  shadowAll(g); world.add(g);
  return { actors: [], obstacles: [{ x: -2, z: 0, r: 0.5 }], spots: [] };
}`;
const entry = (de, box) => ({ box, what: 'a round stone', de, en: 'a stone', den: 'den Stein', the: 'the stone', name_en: 'Stone' });

test('the list is read leniently and only its sane entries are kept', () => {
  assert.equal(parseList('no json here'), null);
  assert.equal(parseList('{"other": 1}'), null);
  assert.deepEqual(parseList('{"things": []}'), []);
  const l = parseList('Sure: {"things": [' + JSON.stringify(entry('ein Stein', [0.1, 0.2, 0.3, 1.4])) + ', {"box": [0.5, 0.5, 0.4, 0.6], "de": "x", "en": "x", "what": "x"}, {"box": "a", "de": "y"}]}');
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].box, [0.1, 0.2, 0.3, 1]);       // clamped to the image
});

async function sheet(list, reply) {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-detect-'));
  for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
  const frame = join(dir, '20261017-120000.jpg');
  execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
  writeFileSync(join(dir, 'list.txt'), list);
  writeFileSync(join(dir, 'reply.txt'), reply);
  process.env.FAKE_CLAUDE_LIST = join(dir, 'list.txt'); process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt'); process.env.FAKE_CLAUDE_LOG = join(dir, 'prompts.jsonl');
  try {
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), newSheet: 'add', bigChange: true });
    let prompts = [];
    try { prompts = readFileSync(join(dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).message.content.at(-1).text); } catch { /* none */ }
    return { r, files: readdirSync(join(dir, 'things')).sort(), prompts };
  } finally { for (const k of ['FAKE_CLAUDE_LIST', 'FAKE_CLAUDE_REPLY', 'FAKE_CLAUDE_LOG']) delete process.env[k]; rmSync(dir, { recursive: true, force: true }); }
}

test('a new sheet is listed first, then every drawing is built by its own call', async () => {
  const { r, files } = await sheet(JSON.stringify({ things: [entry('ein Stein', [0.1, 0.4, 0.3, 0.6]), entry('ein grauer Stein', [0.6, 0.4, 0.8, 0.6])] }), `### NEW\n${stone}`);
  assert.equal(r.error, undefined);
  assert.deepEqual(files, ['stein-2.js', 'stein.js']);
  assert.equal(r.said.length, 2);
  assert.equal(r.calls.filter(c => c.detect).length, 1);
  assert.equal(r.calls.filter(c => c.helper).length, 2);
  assert.equal(typeof r.timing.listed, 'number');
});

test('each build knows the actor ids of the others on the sheet', async () => {
  const { prompts } = await sheet(JSON.stringify({ things: [entry('ein Faultier', [0.1, 0.4, 0.3, 0.6]), entry('ein Ast', [0.1, 0.2, 0.4, 0.4])] }), `### NEW\n${stone}`);
  const sloth = prompts.find(p => p.includes('You build only this one drawing: ein Faultier'));
  const branch = prompts.find(p => p.includes('You build only this one drawing: ein Ast'));
  assert.match(sloth, /its actor id is "faultier"/);
  assert.match(branch, /den Stein \(actor id "faultier" if alive\)/);   // the entries' den is "den Stein" in this fixture
});

test('at most n calls of a kind run at once', async () => {
  const slot = slots(2);
  let now = 0, most = 0;
  await Promise.all([...Array(6)].map(() => slot(async () => { most = Math.max(most, ++now); await new Promise(ok => setTimeout(ok, 10)); now--; })));
  assert.equal(most, 2);
});

test('an unusable list leaves the sheet to the one main call', async () => {
  const { r, files } = await sheet('I cannot tell.', `SEEN: [{"de": "ein Stein", "en": "a stone", "den": "den Stein", "the": "the stone", "name_en": "Stone"}]\n### NEW\n${stone}`);
  assert.equal(r.error, undefined);
  assert.deepEqual(files, ['stein.js']);
  assert.equal(r.calls.filter(c => c.detect).length, 1);
  assert.equal(r.calls.filter(c => !c.detect && !c.helper && !c.fix).length, 1);
});

test('an empty list is an empty sheet: nothing is built', async () => {
  const { r, files } = await sheet('{"things": []}', 'should not be asked');
  assert.equal(r.error, undefined);
  assert.deepEqual(files, []);
  assert.equal(r.calls.length, 1);
});
