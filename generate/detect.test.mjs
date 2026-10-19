// A new sheet: one call lists its drawings, then each is built by its own call (against a fake claude, test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
delete process.env.KRITZEL_MODEL; delete process.env.KRITZEL_DETECT_MODEL;
const { processFrame, parseList, unsaid, withSaid, slots } = await import('./generate.mjs');

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

test('a drawn bubble is kept only when its words are readable, short, child-safe and of a known kind', () => {
  const says = v => parseList(JSON.stringify({ things: [{ ...entry('ein Strichmännchen', [0.1, 0.1, 0.4, 0.6]), says: v }] }))[0].says;
  assert.deepEqual(says({ text: ' Hallo! ', kind: 'speech' }), { text: 'Hallo!', kind: 'speech' });
  assert.deepEqual(says({ text: 'Ich mag Kuchen', kind: 'thought' }), { text: 'Ich mag Kuchen', kind: 'thought' });
  assert.equal(says(null), undefined);
  assert.equal(says({ text: 'Blut!', kind: 'speech' }), undefined);           // not child-safe
  assert.equal(says({ text: 'you are stupid', kind: 'speech' }), undefined);  // not child-safe in English either
  assert.equal(says({ text: 'Die!', kind: 'speech' }), undefined);
  assert.equal(says({ text: 'You will die Tom', kind: 'speech' }), undefined);   // English before a name: no German around it
  assert.equal(says({ text: 'die Max', kind: 'speech' }), undefined);
  assert.deepEqual(says({ text: 'Die Katze ist lieb', kind: 'speech' }), { text: 'Die Katze ist lieb', kind: 'speech' });   // the German article
  assert.equal(says({ text: 'x'.repeat(61), kind: 'speech' }), undefined);   // too long to be a bubble's words
  assert.equal(says({ text: 'Hallo', kind: 'shout' }), undefined);
  assert.equal(says({ text: 3, kind: 'speech' }), undefined);
  assert.deepEqual(says({ text: 'Hallo!', en: 'Hello!', kind: 'speech' }), { text: 'Hallo!', en: 'Hello!', kind: 'speech' });
  assert.deepEqual(says({ text: 'Hallo!', en: 'I hate you', kind: 'speech' }), { text: 'Hallo!', kind: 'speech' });   // its English left out, not the bubble
});

test('the bubble words missing from the module are asked for; present (even escaped) they are not', () => {
  assert.deepEqual(unsaid('greet: [{ de: "Hallo!" }]', null), []);
  assert.deepEqual(unsaid("greet: [{ de: 'Hallo!' }]", { text: 'Hallo!', kind: 'speech' }), []);
  assert.deepEqual(unsaid("chat: [{ de: 'Ich bin\\'s' }]", { text: "Ich bin's", kind: 'thought' }), []);
  assert.match(unsaid("greet: [{ de: 'Hi' }]", { text: 'Hallo!', kind: 'speech' })[0], /first greet line .*"Hallo!"/);
  assert.match(unsaid("greet: [{ de: 'Hi' }]", { text: 'Ich mag Kuchen', kind: 'thought' })[0], /first chat line .*💭/);
});

test('the bubble words are written as the actor\'s lines.said, inside its lines, whatever the model did', async () => {
  const lines = c => Function(`return ${c.match(/actors:\s*\[\s*(\{[\s\S]*\})\s*\]/)[1]}`)().lines;
  const speech = { text: 'Hallo!', en: 'Hello!', kind: 'speech' };
  const a = withSaid("return { actors: [{ id: 'x', lines: { greet: { de: ['Hi'], en: ['Hi'] } } }] };", speech);
  assert.deepEqual(lines(a).said, { de: 'Hallo!', en: 'Hello!' });
  assert.deepEqual(lines(a).greet, { de: ['Hi'], en: ['Hi'] });
  // one the model wrote inside its lines is replaced by the list's words (one beside them is check-run's problem)
  const b = withSaid("return { actors: [{ id: 'x', lines: { said: { de: 'Hi', en: 'Hi' }, chat: ['a'] } }] };", { text: 'Ich mag Kuchen', en: 'I like cake', kind: 'thought' });
  assert.deepEqual(lines(b), { said: { de: '💭 Ich mag Kuchen', en: '💭 I like cake' }, chat: ['a'] });
  assert.deepEqual(lines(withSaid("return { actors: [{ id: 'x', rig: {} }] };", speech)), { said: { de: 'Hallo!', en: 'Hello!' } });
  const spotFirst = withSaid("const s = { kind: 'well', lines: ['Plitsch'] }; return { actors: [{ id: 'x', lines: { chat: ['a'] } }], spots: [s] };", speech);
  assert.match(spotFirst, /lines: \['Plitsch'\]/);                     // a spot's lines before the actor are left alone
  assert.deepEqual(lines(spotFirst).said, { de: 'Hallo!', en: 'Hello!' });
  assert.equal(withSaid('x', { text: 'Hallo!', kind: 'speech' }), 'x');   // no English from the list: the model's stands
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
  // the list's own in_book counts only on the same sheet: alone it builds the drawing
  assert.deepEqual(againInBook([{ de: 'ein Vogel', box: [0, 0, 0.1, 0.1], inBook: 'Vogel' }], birds), []);
  const named = list.map((x, i) => i === 7 ? { ...x, inBook: 'Haus' } : x);   // on the same sheet it does
  assert.ok(againInBook(named, book).some(x => x.inBook === 'Haus'));
});

test('a drawing of several parts built from spheres and boxes is sent back for real silhouettes', async () => {
  const { blobs } = await import('./generate.mjs');
  const parts = '// parts: a\n// parts: b\n// parts: c\n// parts: d\n';
  assert.equal(blobs(parts, { geoms: { SphereGeometry: 6, BoxGeometry: 4 } }).length, 1);
  assert.deepEqual(blobs(parts, { geoms: { SphereGeometry: 4, TubeGeometry: 3, ExtrudeGeometry: 2 } }), []);
  assert.deepEqual(blobs('// parts: ball\n', { geoms: { SphereGeometry: 5 } }), []);          // a ball may be a sphere
});

test('a drawing that gives light must mark its glowing part; a detail that is a star or a fire is not a light', async () => {
  const { unlit } = await import('./generate.mjs');
  const m = (name, drawing) => `export const meta = { name: '${name}', drawing: '${drawing}' };`;
  assert.equal(unlit(m('Kerze', 'a candle with a flame'), { lights: [] }).length, 1);
  assert.equal(unlit(m('Zwei Lichter', 'two candles, each a wax stick'), {}).length, 1);
  assert.deepEqual(unlit(m('Kerze', 'a candle'), { lights: [{ kind: 'lamp', glows: true }] }), []);
  assert.deepEqual(unlit(m('Medaille', 'a gold star medal with a ribbon'), {}), []);
  assert.deepEqual(unlit(m('Feuerwehrboot', 'a fire rescue boat'), {}), []);
  assert.deepEqual(unlit(m('Seestern', 'a starfish'), {}), []);
});

test('switch mode: the old world is archived only when the new sheet yields a thing, right before it is written', async () => {
  const run = async list => {
    const dir = mkdtempSync(join(tmpdir(), 'kritzel-switch-'));
    for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'things', 'alt.js'), `export const meta = { name: 'Alt', drawing: 'x' };\nexport function build() { return { actors: [] }; }`);
    writeFileSync(join(dir, 'reports', 'paper.json'), JSON.stringify({ _through: '20261016-100000.jpg', 'alt.js': { x: 0.5, y: 0.5 } }));
    const frame = join(dir, '20261017-120000.jpg');
    execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
    writeFileSync(join(dir, 'list.txt'), list);
    writeFileSync(join(dir, 'reply.txt'), `### NEW\n${stone}`);
    Object.assign(process.env, { FAKE_CLAUDE_LIST: join(dir, 'list.txt'), FAKE_CLAUDE_REPLY: join(dir, 'reply.txt') });
    const calls = [];
    try {
      const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), newSheet: 'switch',
        beforeFirstWrite: () => { calls.push(readdirSync(join(dir, 'things')).filter(f => f.endsWith('.js'))); rmSync(join(dir, 'things', 'alt.js')); } });
      return { r, calls, files: readdirSync(join(dir, 'things')).filter(f => f.endsWith('.js')), paper: JSON.parse(readFileSync(join(dir, 'reports', 'paper.json'), 'utf8')) };
    } finally { delete process.env.FAKE_CLAUDE_LIST; delete process.env.FAKE_CLAUDE_REPLY; rmSync(dir, { recursive: true, force: true }); }
  };
  const empty = await run('{"things": []}');
  assert.deepEqual(empty.calls, []);                                     // nothing to build: the old world stays
  assert.deepEqual(empty.files, ['alt.js']);
  const one = await run(JSON.stringify({ things: [entry('ein Stein', [0.1, 0.4, 0.3, 0.6]), entry('ein grauer Stein', [0.6, 0.4, 0.8, 0.6])] }));
  assert.deepEqual(one.calls, [['alt.js']]);                             // once, before the first thing was written
  assert.deepEqual(one.files.sort(), ['stein.js', 'stein-2.js'].sort());  // names are unique in the new world, not against the old
  assert.deepEqual(Object.keys(one.paper).sort(), ['_through', 'stein-2.js', 'stein.js']);   // the old world's places stay archived
  assert.equal(one.paper._through, '20261017-120000.jpg');
});

test('drawn water built by hand instead of ctx.water is asked for once', async () => {
  const { plainWater } = await import('./generate.mjs');
  const code = '// parts: rock = a cliff\n// parts: water = five lines down the face\n';
  assert.equal(plainWater(code, { waterCalls: 0 }).length, 1);
  assert.deepEqual(plainWater(code, { waterCalls: 3 }), []);
  assert.deepEqual(plainWater('// parts: rock = a cliff\n', { waterCalls: 0 }), []);
});

test('paper taken away and put back: the places are kept, and the same sheet is not built again', async () => {
  const { againInBook, keepPlacesIfNothing } = await import('./generate.mjs');
  // the guard uses stale places too (an empty table marked them all stale)
  const t = (name, x, y) => ({ meta: { name, paper: { x, y, stale: true } } });
  const book = [t('Haus', 0.66, 0.33), t('Strichfigur', 0.325, 0.545), t('Maus', 0.28, 0.6), t('Sonne', 0.48, 0.22), t('Wolke', 0.52, 0.22)];
  const e = (de, x, y) => ({ de, box: [x - 0.02, y - 0.02, x + 0.02, y + 0.02] });
  const back = [e('ein Haus', 0.66, 0.33), e('ein Mann', 0.325, 0.545), e('eine Maus', 0.28, 0.6), e('eine Sonne', 0.48, 0.22), e('eine Wolke', 0.52, 0.22)];
  assert.equal(againInBook(back, book).length, 5);
  // a big change that built nothing puts the places back as they were
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-paper-'));
  try {
    const before = { _through: '20261017-154656.jpg', 'haus.js': { x: 0.66, y: 0.33 } };
    writeFileSync(join(dir, 'paper.json'), JSON.stringify({ _through: '20261017-154700.jpg', 'haus.js': { x: 0.66, y: 0.33, stale: true } }));
    assert.equal(keepPlacesIfNothing(dir, before, { written: [], removed: [] }), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'paper.json'), 'utf8')), { _through: '20261017-154700.jpg', 'haus.js': { x: 0.66, y: 0.33 } });
    writeFileSync(join(dir, 'paper.json'), JSON.stringify({ _through: 'x', 'haus.js': { x: 0.1, y: 0.1, stale: true } }));
    assert.equal(keepPlacesIfNothing(dir, before, { written: [{}], removed: [] }), false);   // something built: a new sheet
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the same sheet put back moved: the places move with it by the fitted transform', async () => {
  const { againInBook, keepPlacesIfNothing } = await import('./generate.mjs');
  const t = (name, x, y) => ({ meta: { name, paper: { x, y, stale: true } } });
  const book = [t('Haus', 0.6, 0.3), t('Strichfigur', 0.3, 0.5), t('Maus', 0.25, 0.6), t('Sonne', 0.45, 0.2), t('Wolke', 0.5, 0.25)];
  const e = (de, x, y) => ({ de, box: [x - 0.02, y - 0.02, x + 0.02, y + 0.02] });
  const shifted = [e('ein Haus', 0.7, 0.4), e('ein Mann', 0.4, 0.6), e('eine Maus', 0.35, 0.7), e('eine Sonne', 0.55, 0.3), e('eine Wolke', 0.6, 0.35)];
  const again = againInBook(shifted, book);
  assert.equal(again.length, 5);
  assert.ok(Math.abs(again.fit.tx - 0.1) < 0.01 && Math.abs(again.fit.ty - 0.1) < 0.01);
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-paper-'));
  try {
    writeFileSync(join(dir, 'paper.json'), JSON.stringify({ _through: 'b', 'haus.js': { x: 0.6, y: 0.3, stale: true } }));
    keepPlacesIfNothing(dir, { _through: 'a', 'haus.js': { x: 0.6, y: 0.3 } }, { written: [], removed: [], sheetFit: again.fit });
    const p = JSON.parse(readFileSync(join(dir, 'paper.json'), 'utf8'));
    assert.ok(Math.abs(p['haus.js'].x - 0.7) < 0.01 && Math.abs(p['haus.js'].y - 0.4) < 0.01 && !p['haus.js'].stale);
    assert.equal(p._through, 'b');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
