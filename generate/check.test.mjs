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
  assert.ok(problems.some(p => p.includes('off the pages')), problems.join('\n'));
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

test('the world is an open book: things must stand on its pages (x -9..9, z -6.5..6.5)', async () => {
  const at = (x, z) => thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(1, 1, 1), ctx.mat(1))); g.position.set(${x}, 0.5, ${z}); ctx.world.add(g);
    return {};`);
  assert.deepEqual((await buildCheck(at(8, 5.5))).problems, []);
  assert.ok((await buildCheck(at(0, 6.7))).problems.some(p => p.includes('off the pages')));
  assert.ok((await buildCheck(at(-9.2, 0))).problems.some(p => p.includes('off the pages')));
});

test('speech lines: German arrays or { de, en } twins of the same length', async () => {
  const withLines = lines => thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.4, 1, 0.4), ctx.mat(1))); ctx.world.add(g);
    return { actors: [{ id: 'x1', name: 'X', rig: { kind: 'blob', g, say() {}, animate() {} }, lines: ${lines} }] };`);
  assert.deepEqual((await buildCheck(withLines("{ greet: ['Hallo!'] }"))).problems, []);
  assert.deepEqual((await buildCheck(withLines("{ greet: { de: ['Hallo!', 'Hi!'], en: ['Hello!', 'Hi!'] } }"))).problems, []);
  assert.ok((await buildCheck(withLines("{ greet: { de: ['Hallo!', 'Hi!'], en: ['Hello!'] } }"))).problems.some(p => p.includes('twin')));
});

test('actor move: one of walk, hop, crawl, fly, swim, climb', async () => {
  const mv = m => thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.4, 1, 0.4), ctx.mat(1))); ctx.world.add(g);
    return { actors: [{ id: 'v1', name: 'Vogel', move: ${m}, rig: { kind: 'blob', g, say() {}, animate() {} } }] };`);
  assert.deepEqual((await buildCheck(mv("'fly'"))).problems, []);
  assert.ok((await buildCheck(mv("'teleport'"))).problems.some(p => p.includes('move must be')));
});

test('a thing\'s own lines pass the child-safe filter too', async () => {
  const withLines = lines => thing(`const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.4, 1, 0.4), ctx.mat(1))); ctx.world.add(g);
    return { actors: [{ id: 'x1', name: 'X', rig: { kind: 'blob', g, say() {}, animate() {} }, lines: ${lines} }] };`);
  assert.deepEqual((await buildCheck(withLines("{ greet: { de: ['Ich mag Waffeln!'], en: ['I like waffles!'] } }"))).problems, []);
  assert.ok((await buildCheck(withLines("{ chat: { de: ['Du bist dumm!'], en: ['You are nice!'] } }"))).problems.some(p => p.includes('not right for children')));
  assert.ok((await buildCheck(withLines("{ chat: ['Hallo!', 'Ich hasse dich.'] }"))).problems.some(p => p.includes('not right for children')));
});

test('one living figure per module', async () => {
  const two = thing(`const mk = () => { const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.4, 1, 0.4), ctx.mat(1))); ctx.world.add(g); return g; };
    const rig = g => ({ kind: 'person', g, say() {} });
    return { actors: [{ id: 'a1', name: 'Kuh', rig: rig(mk()) }, { id: 'a2', name: 'Pferd', rig: rig(mk()) }] };`);
  assert.ok((await buildCheck(two)).problems.some(p => p.includes('make each living figure its own NEW thing')));
});

test('a branch or pole in a rig is flagged, a long body is not', async () => {
  const rig = mesh => thing(`const g = new ctx.THREE.Group(); ${mesh}
    g.add(new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.4), ctx.mat(1))); ctx.world.add(g);
    return { actors: [{ id: 'a1', name: 'Tier', move: 'climb', rig: { kind: 'tier', g, say() {}, animate() {} } }] };`);
  const bar = `const p = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(0.05, 0.05, 1.8), ctx.mat(2)); p.rotation.z = Math.PI / 2; p.position.y = 1.5; g.add(p);`;
  const post = `const p = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(0.05, 0.05, 1.6), ctx.mat(2)); p.position.set(1, 0.8, 0); g.add(p);`;
  const pencil = `const p = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(0.11, 0.11, 1.8), ctx.mat(2)); p.position.y = 0.9; g.add(p);`;
  for (const m of [bar, post]) assert.ok((await buildCheck(rig(m))).problems.some(p => p.includes('pole or branch')), m);
  assert.ok(!(await buildCheck(rig(pencil))).problems.some(p => p.includes('pole or branch')));
  const wing = rig(bar).replace("move: 'climb'", "move: 'fly'");          // a plane's wing high up is no branch
  assert.ok(!(await buildCheck(wing)).problems.some(p => p.includes('pole or branch')));
  const perch = thing(`const g = new ctx.THREE.Group();                         // a bird carrying its perch below it
    const p = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(0.05, 0.05, 1.8), ctx.mat(2)); p.rotation.z = Math.PI / 2; p.position.y = 0.9; g.add(p);
    const b = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.3), ctx.mat(1)); b.position.y = 1.25; g.add(b); ctx.world.add(g);
    return { actors: [{ id: 'a1', name: 'Vogel', move: 'fly', rig: { kind: 'vogel', g, say() {}, animate() {} } }] };`);
  assert.ok((await buildCheck(perch)).problems.some(p => p.includes('pole or branch')));
});

test('a rig that throws in the book\'s sim is caught (live 2026-10-17: person rig without limbs)', async () => {
  const limbless = thing(`const g = new ctx.THREE.Group(), m = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(0.3, 0.3, 1.2), ctx.mat(1)); m.position.y = 0.6; g.add(m); ctx.world.add(g);
    const rig = { kind: 'person', g, say() {} };
    return { actors: [{ id: 'zylinder', name: 'Zylinder', rig: { ...rig, animate: rig.animate } }] };`);
  const p = (await buildCheck(limbless)).problems;
  assert.ok(p.some(x => x.includes("the book's sim throws") && x.includes('makePerson')), p.join('\n'));
  const person = thing(`const r = ctx.makePerson({ shirtColor: 0x3366cc }); return { actors: [{ id: 'paul', name: 'Paul', rig: r }] };`);
  assert.deepEqual((await buildCheck(person)).problems, []);
});

test('a creature built up in the air is supported by what is above it or under it', async () => {
  const up = (scenery) => thing(`const g = new ctx.THREE.Group(), b = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.3), ctx.mat(1)); b.position.y = 1.5; g.add(b); ctx.world.add(g);
    ${scenery}
    return { actors: [{ id: 'vogel', name: 'Vogel', move: 'climb', rig: { kind: 'vogel', g, say() {}, animate() {} } }] };`);
  const hanging = async code => (await buildCheck(code)).info.hanging?.[0];
  const seat = 'const s = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.8, 0.1, 0.4), ctx.mat(2)); s.position.y = 1.15; ctx.world.add(s);';      // a swing seat under it
  const branch = 'const s = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(1.2, 0.1, 0.1), ctx.mat(2)); s.position.y = 1.85; ctx.world.add(s);';  // a branch over it
  assert.equal((await hanging(up(''))).supported, false);
  assert.equal((await hanging(up(seat))).supported, true);
  assert.equal((await hanging(up(branch))).supported, true);
});

test('the check says whether a figure could carry the thing, by the viewer\'s own rule (viewer/portable.js)', async () => {
  const { isPortable } = await import('../viewer/portable.js');
  assert.equal(isPortable({ hx: 0.4, hz: 0.4, top: 0.8 }), true);
  assert.equal(isPortable({ hx: 1.65, hz: 1, top: 1 }), false);                                  // the 3.3-wide gummy box
  assert.equal(isPortable({ hx: 0.4, hz: 0.4, top: 0.8, lightKinds: ['lamp'] }), true);         // a hand lamp rides along
  assert.equal(isPortable({ hx: 0.4, hz: 0.4, top: 0.8, lightKinds: ['sun'] }), false);
  assert.equal(isPortable({ hx: 0.4, hz: 0.4, top: 0.8, actors: 1 }), false);
  assert.equal(isPortable({ hx: 0.4, hz: 0.4, top: 0.8, spotKinds: ['door'] }), false);
  const small = `export const meta = { name: 'Stein', drawing: 'a stone' };
export function build(ctx) { const { THREE, world, mat } = ctx; const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.DodecahedronGeometry(0.4), mat(0x999999))); g.position.y = 0.4; world.add(g); return { actors: [] }; }`;
  const big = small.replace("'Stein'", "'Haus'").replace('DodecahedronGeometry(0.4)', 'BoxGeometry(3, 3, 3)').replace('g.position.y = 0.4', 'g.position.y = 1.5');
  assert.equal((await buildCheck(small, { takenIds: [] })).info.portable, true);
  assert.equal((await buildCheck(big, { takenIds: [] })).info.portable, false);
});

test('the check counts hand-built shapes whose faces point inward (they render black); wound outward they are fine', async () => {
  const tetra = order => `export const meta = { name: 'Hügel', drawing: 'a hill' };
export function build(ctx) {
  const { THREE, world, mat } = ctx;
  const p = [[-1, 0, -1], [1, 0, -1], [0, 0, 1], [0, 1.2, 0]].flat();
  const faces = ${order};
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); geo.setIndex(faces); geo.computeVertexNormals();
  const g = new THREE.Group(); g.add(new THREE.Mesh(geo, mat(0xe8a46a))); world.add(g);
  return { actors: [] };
}`;
  const outward = '[0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0]', inward = '[0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]';
  assert.equal((await buildCheck(tetra(inward), { takenIds: [] })).info.inwardMeshes, 1);   // reported; generate asks once (advisory)
  assert.equal((await buildCheck(tetra(outward), { takenIds: [] })).info.inwardMeshes, 0);
});
