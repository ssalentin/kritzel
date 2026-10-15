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
  const r = parseReply('### NEW\n```js\nexport const meta = {};\n```\n### UPDATE bana.js\ncode2\n### REMOVE wolke.js\nthe cloud was erased\n### UNCLEAR\na line | anything');
  assert.deepEqual(r.map(s => [s.kind, s.file]), [['NEW', null], ['UPDATE', 'bana.js'], ['REMOVE', 'wolke.js'], ['UNCLEAR', null]]);
  assert.equal(r[0].body, 'export const meta = {};');
  assert.throws(() => parseReply('export const meta = {};'), /no ### sections/);
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
});
