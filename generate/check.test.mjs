// node --test (in generate/): the offline checks, no Claude calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { staticCheck, buildCheck } from './check.mjs';
import { parseReply } from './generate.mjs';

const example = f => readFileSync(new URL('./examples/' + f, import.meta.url), 'utf8');
const thing = body => `export const meta = { name: 'x', drawing: 'y' };\nexport function build(ctx) {\n${body}\n}\n`;

test('the reference examples pass every check', async () => {
  for (const f of ['schnecke.js', 'haus.js']) {
    assert.deepEqual(staticCheck(example(f)), [], f);
    assert.deepEqual((await buildCheck(example(f))).problems, [], f);
  }
});

test('words in strings and comments are not code', () => {
  assert.deepEqual(staticCheck(thing(`// fetch the window\nconst d = 'a door and one window'; return {};`)), []);
});

test('reaching out of ctx is rejected', () => {
  for (const bad of [`fetch('http://x')`, `document.title = 1`, `window.x = 1`, `eval('1')`, `new Function('return 1')`,
    `import('http://x')`, `localStorage.x = 1`, `new ctx.THREE.TextureLoader()`, `const s = \`\${fetch('x')}\``])
    assert.notDeepEqual(staticCheck(thing(bad + '; return {};')), [], bad);
});

test('a creature without its own animation, a duplicate id, and a thing off the island are caught', async () => {
  const blob = thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.5), ctx.mat(0xffffff)));
    g.position.set(9, 0.5, 0); ctx.world.add(g);
    return { actors: [{ id: 'schnecke', rig: { kind: 'blob', g, say() {} } }] };`);
  const { problems } = await buildCheck(blob, { takenIds: ['schnecke'] });
  assert.ok(problems.some(p => p.includes('already taken')), problems.join('\n'));
  assert.ok(problems.some(p => p.includes('no rig.animate')), problems.join('\n'));
  assert.ok(problems.some(p => p.includes('island')), problems.join('\n'));
});

test('a build that throws or adds nothing is caught', async () => {
  assert.match((await buildCheck(thing(`throw new Error('boom');`))).problems[0], /throws: boom/);
  assert.ok((await buildCheck(thing(`return {};`))).problems.some(p => p.includes('nothing visible')));
});

test('model code runs sandboxed: no file writes, no network, endless loops are killed', async () => {
  const write = thing(`(0, eval)('pro' + 'cess').getBuiltinModule('fs').writeFileSync('/tmp/kritzel-pwned', 'x'); return {};`);
  assert.match((await buildCheck(write)).problems.join(), /restricted|not defined|Access/);
  const net = thing(`return fetch('http://127.0.0.1:8765/').then(() => { throw new Error('NET-OK'); }, () => { throw new Error('NET-BLOCKED'); });`);
  assert.match((await buildCheck(net)).problems.join(), /NET-BLOCKED/);
  const loop = thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(1, 1, 1), ctx.mat(1))); ctx.world.add(g);
    return { update(t) { if (t > 5) for (;;) {} } };`);
  assert.match((await buildCheck(loop)).problems.join(), /did not finish/);
});

test('replies are split into NEW / UPDATE / REMOVE / UNCLEAR sections', () => {
  assert.deepEqual(parseReply('NOTHING'), []);
  assert.deepEqual(parseReply('UNCLEAR\na zigzag | a scribble').map(s => [s.kind, s.body]), [['UNCLEAR', 'a zigzag | a scribble']]);
  const r = parseReply('### NEW\n```js\nexport const meta = {};\n```\n### UPDATE bana.js\ncode2\n### REMOVE wolke.js\nthe cloud was erased\n### UNCLEAR\na line | anything');
  assert.deepEqual(r.map(s => [s.kind, s.file]), [['NEW', null], ['UPDATE', 'bana.js'], ['REMOVE', 'wolke.js'], ['UNCLEAR', null]]);
  assert.equal(r[0].body, 'export const meta = {};');
  assert.throws(() => parseReply('just some words'), /no ### sections/);
  assert.deepEqual(parseReply('export const meta = {};\nexport function build(ctx) {}').map(s => s.kind), ['NEW']);
});

test('light: shape is checked, at most 3 lamps per thing', async () => {
  const withLights = n => thing(`const g = new ctx.THREE.Group(); const m = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.2), ctx.mat(0xffcc00)); g.add(m); ctx.world.add(g);
    return { light: [${Array.from({ length: n }, () => "{ kind: 'lamp', object3D: m, intensity: 1, flicker: true }").join(', ')}] };`);
  assert.deepEqual((await buildCheck(withLights(3))).problems, []);
  assert.ok((await buildCheck(withLights(4))).problems.some(p => p.includes('at most 3')));
  const bad = thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(1, 1, 1), ctx.mat(1))); ctx.world.add(g);
    return { light: { kind: 'torch', intensity: 9 } };`);
  assert.ok((await buildCheck(bad)).problems.some(p => p.includes("'sun', 'moon' or 'lamp'")));
  const moon = thing(`const g = new ctx.THREE.Group(); const d = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.5), ctx.mat(0xffffcc)); g.add(d); g.position.y = 4; ctx.world.add(g);
    return { light: { kind: 'moon', object3D: d } };`);
  assert.deepEqual((await buildCheck(moon)).problems, []);
  const far = withLights(1).replace("intensity: 1,", "intensity: 1, range: 50,");
  assert.ok((await buildCheck(far)).problems.some(p => p.includes('range must be 0-20')));
});

test('holds: the actor must exist and the circle must have room inside', async () => {
  const jail = obstacles => thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(2, 1, 2), ctx.mat(1))); g.position.set(1, 0.5, 1); ctx.world.add(g);
    return { obstacles: ${obstacles}, holds: [{ actor: 'spinne', x: 1, z: 1, r: 0.8 }] };`);
  assert.deepEqual((await buildCheck(jail('[{ x: 0, z: 1, r: 0.15 }, { x: 2, z: 1, r: 0.15 }]'), { takenIds: ['spinne'] })).problems, []);
  assert.ok((await buildCheck(jail('[{ x: 1, z: 1, r: 1.1 }]'), { takenIds: ['spinne'] })).problems.some(p => p.includes('no room inside')));
  assert.ok((await buildCheck(jail('[]'), { takenIds: [] })).problems.some(p => p.includes('on the island nowhere')));
});

test('water: more than 6 pieces or oversized ones are reported', async () => {
  const many = thing(`const g = new ctx.THREE.Group(); for (let i = 0; i < 7; i++) g.add(ctx.water.pond(i * 0.5 - 1.5, 0, 0.3)); ctx.world.add(g); return {};`);
  assert.ok((await buildCheck(many)).problems.some(p => p.includes('at most 6')));
  const big = thing(`const g = new ctx.THREE.Group(); g.add(ctx.water.river([[0, 0], [1, 1]], 5)); ctx.world.add(g); return {};`);
  assert.ok((await buildCheck(big)).problems.some(p => p.includes('width 5 is over the limit 3')));
  const ok = thing(`const g = new ctx.THREE.Group(); g.add(ctx.water.pond(0, 0, 1)); g.add(ctx.water.waterfall([0, 2, 0], [1, 0, 0], 0.6)); ctx.world.add(g); return {};`);
  assert.deepEqual((await buildCheck(ok)).problems, []);
});

test('sheet moves: paper positions follow capture\'s affine, frame by frame, once', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { movePaperAlong } = await import('./generate.mjs');
  const d = mkdtempSync(join(tmpdir(), 'kritzel-paper-')), settled = join(d, 'settled'), things = join(d, 'things'), reports = join(d, 'reports');
  for (const p of [settled, things, reports]) mkdirSync(p);
  writeFileSync(join(things, 'mond.js'), thing('return {};').replace("drawing: 'y' }", "drawing: 'y', paper: { x: 0.5, y: 0.25 } }"));
  const frame = (ts, affine) => { writeFileSync(join(settled, ts + '.json'), JSON.stringify({ affine, width: 1920, height: 1080 })); writeFileSync(join(settled, ts + '.jpg'), ''); };
  frame('20261016-030000', null);
  writeFileSync(join(reports, 'paper.json'), JSON.stringify({ _through: '20261016-030000.jpg' }));
  frame('20261016-030100', [1, 0, 96, 0, 1, -54]);   // the sheet moved right and up
  frame('20261016-030200', null);                     // not measured: no move
  frame('20261016-030300', [1, 0, 96, 0, 1, 0]);
  await movePaperAlong(settled, '20261016-030300.jpg', { thingsDir: things, reportsDir: reports });
  const p = JSON.parse(readFileSync(join(reports, 'paper.json'), 'utf8'));
  assert.deepEqual(p['mond.js'], { x: 0.6, y: 0.2 });   // (960 + 192) / 1920, (270 - 54) / 1080
  assert.equal(p._through, '20261016-030300.jpg');
  await movePaperAlong(settled, '20261016-030300.jpg', { thingsDir: things, reportsDir: reports });   // nothing new: no second move
  assert.deepEqual(JSON.parse(readFileSync(join(reports, 'paper.json'), 'utf8'))['mond.js'], { x: 0.6, y: 0.2 });
  // a big change capture could not measure: positions are unknown now, and stay marked through later moves
  writeFileSync(join(settled, '20261016-030400.json'), JSON.stringify({ reason: 'big-change', affine: null })); writeFileSync(join(settled, '20261016-030400.jpg'), '');
  frame('20261016-030500', [1, 0, 0, 0, 1, 19.2]);
  await movePaperAlong(settled, '20261016-030500.jpg', { thingsDir: things, reportsDir: reports });
  const q = JSON.parse(readFileSync(join(reports, 'paper.json'), 'utf8'))['mond.js'];
  assert.equal(q.stale, true);
});

test('weather: kind is checked', async () => {
  const w = kinds => thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.5), ctx.mat(0xffffff))); g.position.y = 3; ctx.world.add(g);
    return { weather: ${kinds} };`);
  assert.deepEqual((await buildCheck(w("{ kind: 'rain' }"))).problems, []);
  assert.deepEqual((await buildCheck(w("[{ kind: 'rainbow' }, { kind: 'lightning' }]"))).problems, []);
  assert.ok((await buildCheck(w("{ kind: 'hail' }"))).problems.some(p => p.includes("weather.kind")));
});

test('actors of one thing need their own names', async () => {
  const two = (n1, n2) => thing(`const mk = () => { const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.4, 1, 0.4), ctx.mat(1))); ctx.world.add(g); return g; };
    const rig = g => ({ kind: 'person', g, say() {} });
    return { actors: [{ id: 'k1', name: '${n1}', rig: rig(mk()) }, { id: 'k2', name: '${n2}', rig: rig(mk()) }] };`);
  assert.ok((await buildCheck(two('Kerze', 'Kerze'))).problems.some(p => p.includes('share a name')));
  assert.ok(!(await buildCheck(two('Große Kerze', 'Kleine Kerze'))).problems.some(p => p.includes('share a name')));
});

test('dialogue filter: German "die" is an article, English "die" is not', async () => {
  const { safeLine, safeDialogue } = await import('../viewer/dialogues.js');
  assert.ok(safeLine('Schau, die Sonne!', 'de'));
  assert.ok(safeLine('Wo ist die Kerze?', 'de'));
  assert.ok(!safeLine('Du bist so dumm!', 'de'));
  assert.ok(safeLine('Das ist total lustig!', 'de'));
  assert.ok(!safeLine('Der Vogel ist tot.', 'de'));
  assert.ok(!safeLine('I will die', 'en'));
  assert.ok(safeLine('Look at the sun!', 'en'));
  const d = { between: ['A', 'B'], end: null, turns: [{ who: 'A', de: 'Schau, die Sonne!', en: 'Look, the sun!' }, { who: 'B', de: 'Die ist schön.', en: 'It is pretty.' }] };
  assert.ok(safeDialogue(d));
});

test('dialogue filter: whole words only, per language (issue #12)', async () => {
  const { safeLine } = await import('../viewer/dialogues.js');
  for (const [t, l] of [['Ich mag Waffeln!', 'de'], ['Wir gehen in die Drogerie.', 'de'], ['Eine Blutorange!', 'de'], ['Look, a shooting star!', 'en'],
    ['Off to the drugstore!', 'en'], ['Schau, die Sonne!', 'de'], ['Das ist total lustig!', 'de'], ['Ich weine nicht.', 'de']])
    assert.ok(safeLine(t, l), 'must pass: ' + t);
  for (const [t, l] of [['Der Vogel ist tot.', 'de'], ['Du bist so dumm!', 'de'], ['So ein scheiß Tag', 'de'], ['Er hat Waffen.', 'de'], ['Du Idiot!', 'de'], ['Scheißding!', 'de'],
    ['Blut überall', 'de'], ['I will die', 'en'], ['He has guns', 'en'], ['They were shooting', 'en'], ['You are stupid', 'en']])
    assert.ok(!safeLine(t, l), 'must be blocked: ' + t);
});

test('speech lines: German arrays or { de, en } twins of the same length', async () => {
  const withLines = lines => thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.4, 1, 0.4), ctx.mat(1))); ctx.world.add(g);
    return { actors: [{ id: 'x1', name: 'X', rig: { kind: 'person', g, say() {} }, lines: ${lines} }] };`);
  assert.deepEqual((await buildCheck(withLines("{ greet: ['Hallo!'] }"))).problems, []);
  assert.deepEqual((await buildCheck(withLines("{ greet: { de: ['Hallo!', 'Hi!'], en: ['Hello!', 'Hi!'] } }"))).problems, []);
  assert.ok((await buildCheck(withLines("{ greet: { de: ['Hallo!', 'Hi!'], en: ['Hello!'] } }"))).problems.some(p => p.includes('twin')));
});
