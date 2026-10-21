import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSource, parseMeta } from '../scripts/pixel-world.mjs';
import { archetype } from '../viewer/pixel/art.js';
import { label } from '../viewer/pixel/layout.js';

const thing = (file, name, drawing, x, y) => `export const meta = {
  name: ${JSON.stringify(name)},
  drawing: ${JSON.stringify(drawing)},
  paper: { x: ${x}, y: ${y} },
};
export function build() { return {}; }
`;

test('pixel world reads the same thing meta the viewer uses', () => {
  const meta = parseMeta('gelbe-blume.js', thing('gelbe-blume.js', 'Gelbe Blume', 'a yellow flower', .62, .31));
  assert.deepEqual(meta, { file: 'gelbe-blume.js', name: 'Gelbe Blume', drawing: 'a yellow flower', kind: '', paper: { x: .62, y: .31 } });
  assert.equal(archetype(meta), 'flower');
});

test('pixel world picks a readable sprite for common drawings', () => {
  const cases = [
    ['Wolkenkratzer', 'a skyscraper', 'tower'],
    ['Hexe', 'a witch on a broom', 'witch'],
    ['Maus', 'a tiny mouse', 'mouse'],
    ['Kritzelwesen', 'a scribble creature', 'scribble'],
    ['Keks', 'a biscuit', 'cookie'],
  ];
  for (const [name, drawing, kind] of cases) assert.equal(archetype({ name, drawing, kind: '' }), kind);
});

test('pixel world source is valid JavaScript and deterministic', () => {
  const things = [
    parseMeta('hexe.js', thing('hexe.js', 'Hexe', 'a witch', .2, .3)),
    parseMeta('baum.js', thing('baum.js', 'Baum', 'a tree', .8, .7)),
  ];
  const first = makeSource(things), second = makeSource(things.slice().reverse());
  assert.equal(first, second);
  assert.doesNotThrow(() => new Function(first));
  assert.match(first, /scene\("kritzel", \{ w: 320, h: 200,/);
  assert.match(first, /stamp\("fallback-witch", \d+, \d+/);
  assert.match(first, /stamp\("fallback-tree", \d+, \d+/);
});

test('pixel labels are uppercase ASCII and bounded for the 320 px scene', () => {
  assert.equal(label('große Grüße!'), 'GROSSE GRUSSE!');
  assert.equal(label('a very long drawing name'), 'A VERY LONG DR');
  assert.equal(label('💭'), 'THING');
});
