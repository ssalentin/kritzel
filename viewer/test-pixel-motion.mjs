// Pixel-side mover choices and stepping: node --test viewer/test-pixel-motion.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActor, moverFor, MOVERS, react, stepActor } from './pixel/motion.js';

test('the mover follows explicit meta, then the drawing', () => {
  assert.equal(moverFor({ move: 'fly', name: 'Drache', drawing: 'a dragon' }), 'fly');
  assert.equal(moverFor({ name: 'Mara', drawing: 'a girl in a wheelchair' }), 'roll');
  assert.equal(moverFor({ name: 'Fisch', drawing: 'a blue fish' }), 'swim');
  assert.equal(moverFor({ name: 'Schnecke', drawing: 'a slow snail' }), 'crawl');
  assert.equal(moverFor({ name: 'Hase', drawing: 'a hopping rabbit' }), 'hop');
  assert.equal(moverFor({ name: 'Spinne', drawing: 'a spider' }), 'climb');
  assert.equal(moverFor({ name: 'Roter Panda', drawing: 'a red panda in a tree' }), 'climb');
  assert.equal(moverFor({ name: 'Mira', drawing: 'a child' }), 'walk');
  assert.equal(moverFor({ name: 'Maedchen', drawing: 'a girl walking across the book' }), 'walk');
  assert.equal(moverFor({ name: 'Stuhl', drawing: 'a chair with a friendly face' }), 'walk');
  assert.equal(moverFor({ name: 'Tasse', drawing: 'a cup of coffee' }), 'walk');
  assert.equal(moverFor({ name: 'Mond', drawing: 'the moon phase' }), 'walk');
  assert.equal(moverFor({ name: 'Kind', drawing: 'a girl carrying a cookie' }), 'walk');
});

test('an actor moves toward its target and a solid thing blocks it', () => {
  const actor = createActor({ file: 'maus.json', name: 'Maus', kind: 'actor', x: 100, y: 100, speed: 20 }, 3);
  actor.pause = 0;
  actor.target = { x: 120, y: 100 };
  stepActor(actor, .1);
  assert.ok(actor.x > 100);
  assert.equal(actor.state, 'move');

  const blocked = createActor({ file: 'kind.json', name: 'Kind', kind: 'actor', x: 100, y: 100, speed: 20 }, 4);
  blocked.pause = 0;
  blocked.target = { x: 120, y: 100 };
  stepActor(blocked, .1, [{ x: 112, y: 100, w: 8, h: 20, kind: 'chest' }]);
  assert.equal(blocked.x, 100);
  assert.equal(blocked.target, null);
});

test('every mover advances on the page', () => {
  for (const mover of MOVERS) {
    const actor = createActor({ file: mover + '.json', name: mover, kind: 'actor', move: mover,
      x: 100, y: mover === 'fly' ? 80 : 135, speed: 20 }, 9);
    actor.pause = 0;
    actor.target = { x: 120, y: actor.y + 10 };
    const before = [actor.x, actor.y];
    stepActor(actor, .1);
    assert.ok(Math.hypot(actor.x - before[0], actor.y - before[1]) > .5, mover);
  }
});

test('a flyer crosses the footprint a walker must go around', () => {
  const wall = { x: 112, y: 90, w: 10, h: 60, kind: 'tower' };
  for (const mover of ['walk', 'fly']) {
    const actor = createActor({ file: mover + '.json', name: mover, kind: 'actor', move: mover, x: 100, y: 90, speed: 20 });
    actor.pause = 0;
    actor.target = { x: 120, y: 90 };
    stepActor(actor, .1, [wall]);
    if (mover === 'fly') assert.ok(actor.x > 100);
    else assert.equal(actor.x, 100);
  }
});

test('a tap greets and then returns to movement; sleep waits for the tap', () => {
  const actor = createActor({ file: 'panda.json', name: 'Panda', kind: 'actor', state: 'sleep', x: 80, y: 100 }, 5);
  assert.equal(actor.state, 'sleep');
  stepActor(actor, 2);
  assert.equal(actor.state, 'sleep');
  react(actor);
  assert.equal(actor.state, 'greet');
  stepActor(actor, .05);
  assert.equal(actor.state, 'greet');
  assert.ok(actor.react > .9);
  actor.target = { x: 120, y: 100 };
  for (let i = 0; i < 20; i++) stepActor(actor, .05);
  assert.notEqual(actor.state, 'sleep');
});

test('ten actors against forty obstacles keep a small frame budget', () => {
  const obstacles = Array.from({ length: 40 }, (_, i) => ({
    x: 34 + (i % 10) * 25, y: 74 + Math.floor(i / 10) * 24, w: 10, h: 12, kind: 'scenery',
  }));
  const actors = Array.from({ length: 10 }, (_, i) =>
    createActor({ file: `${i}.json`, name: i % 2 ? 'Drache' : 'Mira', kind: 'actor', x: 40 + i * 24, y: 100 }, i));
  const started = performance.now();
  for (let frame = 0; frame < 600; frame++) for (const actor of actors) stepActor(actor, 1 / 60, obstacles);
  assert.ok(performance.now() - started < 1000, 'movement logic should fit comfortably in a 60 fps frame budget');
});
