import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSource, parseThing } from '../scripts/pixel-world.mjs';
import { archetype } from '../viewer/pixel/art.js';
import { label } from '../viewer/pixel/layout.js';

const thing = (name, drawing, x, y, sprite) => JSON.stringify({ name, drawing, paper: { x, y }, sprite });

test('pixel world reads the pixel thing JSON and its sprite', () => {
  const meta = parseThing('gelbe-blume.json', thing('Gelbe Blume', 'a yellow flower', .62, .31, 'gelbe-blume.png'));
  assert.deepEqual(meta, { file: 'gelbe-blume.json', name: 'Gelbe Blume', drawing: 'a yellow flower', kind: '',
    paper: { x: .62, y: .31 }, sprite: 'gelbe-blume.png' });
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
    parseThing('hexe.json', thing('Hexe', 'a witch', .2, .3, 'hexe.png')),
    parseThing('baum.json', thing('Baum', 'a tree', .8, .7, 'baum.png')),
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
