// node --test (in generate/): the offline checks, no Claude calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { staticCheck, buildCheck } from './check.mjs';

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
