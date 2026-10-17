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

test('a drawing whose eyes are below its mouth in the image lies upside down; anything else is upright', () => {
  const l = parseList(JSON.stringify({ things: [{ ...entry('eine Sonne', [0, 0, 1, 1]), face: 'eyes below mouth' }, { ...entry('eine Schlange', [0, 0, 1, 1]), face: 'eyes beside mouth' }, { ...entry('eine Fledermaus', [0, 0, 1, 1]), face: 'eyes below mouth', hangs: true }, { ...entry('ein Stein', [0, 0, 1, 1]), face: 'upside?' }, entry('ein Haus', [0, 0, 1, 1])] }));
  assert.deepEqual(l.map(x => x.up), ['upside down', 'upright', 'upright', 'upright', 'upright']);   // the bat hangs: not turned
});

test('a drawing lying upside down is built from the image turned round, placed where it really is', async () => {
  const list = JSON.stringify({ things: [{ ...entry('eine Sonne', [0.1, 0.2, 0.3, 0.4]), face: 'eyes below mouth' }] });
  const { prompts } = await sheet(list, `### NEW\n${stone}`);
  const p = prompts.find(x => x.includes('You build only this one drawing: eine Sonne'));
  assert.match(p, /shown turned round/);
  assert.match(p, /inside the box \[0\.7,0\.6,0\.9,0\.8\]/);          // the box in the turned image
  assert.match(p, /paper \{ x: 0\.2, y: 0\.3 \}/);                    // the place on the real paper
});

test('a word written alone is not a thing: not listed, and a module that only shows writing is not built', async () => {
  const { wordOnly } = await import('./generate.mjs');
  const m = (n, d) => `export const meta = { name: '${n}', drawing: '${d}' };`;
  assert.equal(wordOnly(m('Sqichy-Wort', 'the handwritten word "Sqichy" in blue pen')), true);
  assert.equal(wordOnly(m('Haus', 'a house labelled Haus! with an arrow')), false);
  assert.equal(wordOnly(m('Vogel', 'a bird with the word Vogel next to it')), false);
  const l = parseList(JSON.stringify({ things: [{ ...entry('ein Wort', [0, 0, 0.2, 0.1]), what: 'the handwritten word Sqichy at the top' }, entry('ein Stein', [0, 0, 1, 1])] }));
  assert.deepEqual(l.map(x => x.de), ['ein Stein']);
});

test('a building or object without a drawn face is not a figure', async () => {
  const { notAlive } = await import('./generate.mjs');
  const m = (name, drawing, parts = '') => `${parts}\nexport const meta = { name: '${name}', drawing: '${drawing}' };`;
  assert.equal(notAlive(m('Haus', 'a pointed house with a door, a window and smoke', '// parts: walls = a box\n// parts: door = a rectangle')), true);
  assert.equal(notAlive(m('Haus', 'a house with eyes and a smiling mouth')), false);         // drawn alive
  assert.equal(notAlive(m('Maus', 'a mouse')), false);
  assert.equal(notAlive(m('Flugzeug', 'a plane')), false);                                  // flies: an actor on purpose
});

test('the same sheet seen again: what is in the book already is not built twice, by kind and place', async () => {
  const { againInBook } = await import('./generate.mjs');
  const t = (name, x, y) => ({ meta: { name, paper: { x, y } } });
  // the book from 154656 (its paper places), and 154727 as listed: the sheet shifted, turned and smaller, plus 3 birds
  const book = [t('Haus', 0.66, 0.33), t('Strichfigur', 0.325, 0.545), t('Maus', 0.28, 0.6), t('Sonne', 0.48, 0.22), t('Strichfigur', 0.42, 0.47),
    t('Strichfigur', 0.37, 0.56), t('Wolke', 0.52, 0.22)];
  const e = (de, x, y) => ({ de, box: [x - 0.02, y - 0.02, x + 0.02, y + 0.02] });
  const list = [e('eine Maus', 0.81, 0.65), e('ein Mann', 0.86, 0.59), e('ein Kind', 0.9, 0.58), e('eine Wolke', 0.94, 0.34), e('eine Sonne', 0.95, 0.46),
    e('ein Mensch', 0.96, 0.53), e('ein Vogel', 0.86, 0.38), e('ein Vogel', 0.91, 0.41), e('ein Vogel', 0.88, 0.29)];
  const again = againInBook(list, book);
  assert.deepEqual(list.filter(x => !again.includes(x)).map(x => x.de), ['ein Vogel', 'ein Vogel', 'ein Vogel']);
  // review's case: a NEW sheet of familiar kinds (3 birds and a house) next to a book of 4 birds, 2 figures, a sun
  const birds = [t('Vogel', 0.2, 0.2), t('Vogel', 0.3, 0.25), t('Vogel', 0.4, 0.2), t('Vogel', 0.5, 0.25), t('Strichfigur', 0.3, 0.7), t('Strichfigur', 0.6, 0.7), t('Sonne', 0.8, 0.15)];
  const fresh = [e('ein Vogel', 0.6, 0.3), e('ein Vogel', 0.7, 0.35), e('ein Vogel', 0.8, 0.3), e('ein Haus', 0.4, 0.6)];
  assert.deepEqual(againInBook(fresh, birds), []);
  // named by the list itself
  assert.deepEqual(againInBook([{ de: 'ein Ding', box: [0, 0, 1, 1], inBook: 'Haus' }], book).map(x => x.inBook), ['Haus']);
});
