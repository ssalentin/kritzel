// Matter.js top-down physics: node --test viewer/test-pixel-physics.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from '../generate/node_modules/matter-js/build/matter.js';
import { createPhysics, MAX_THROW_SPEED, PHYSICS_STEP_MS } from './pixel/physics.js';

const bounds = { x0: 10, x1: 110, y0: 10, y1: 110 };
const thing = (id, x, y, w = 12, h = 12) => ({ id, cx: x, cy: y, w, h });
const run = (physics, n, moveActor = null) => {
  for (let i = 0; i < n; i++) {
    moveActor?.(i);
    physics.step(PHYSICS_STEP_MS / 1000);
  }
};

test('the page boundary stops a moving body', () => {
  const item = thing('edge', 30, 50);
  const physics = createPhysics(Matter, { bounds, portables: [item] });
  const body = physics.portableBodies.get(item);
  Matter.Body.setVelocity(body, { x: 9, y: 0 });
  run(physics, 80);
  assert.ok(body.position.x >= 14 && body.position.x <= 106, body.position);
});

test('two dynamic bodies resolve a collision without overlapping', () => {
  const a = thing('a', 28, 50), b = thing('b', 50, 50);
  const physics = createPhysics(Matter, { bounds, portables: [a, b] });
  Matter.Body.setVelocity(physics.portableBodies.get(a), { x: 5, y: 0 });
  run(physics, 60);
  const ba = physics.portableBodies.get(a), bb = physics.portableBodies.get(b);
  assert.ok(Math.abs(ba.position.x - bb.position.x) >= 11.5, [ba.position, bb.position]);
});

test('mass follows the sprite area', () => {
  const small = thing('small', 25, 50, 8, 8), large = thing('large', 70, 50, 30, 30);
  const physics = createPhysics(Matter, { bounds, portables: [small, large] });
  assert.ok(physics.portableBodies.get(large).mass > physics.portableBodies.get(small).mass * 2);
});

test('a shoved body slows under friction', () => {
  const item = thing('slider', 50, 50);
  const physics = createPhysics(Matter, { bounds, portables: [item] });
  const body = physics.portableBodies.get(item);
  Matter.Body.setVelocity(body, { x: 7, y: 0 });
  run(physics, 24);
  assert.ok(body.speed < 5.2, body.speed);
});

test('a thrown body collides with a static thing', () => {
  const item = thing('ball', 30, 50), wall = thing('tree', 80, 50, 10, 30);
  const physics = createPhysics(Matter, { bounds, statics: [wall], portables: [item] });
  let hit = false;
  Matter.Events.on(physics.engine, 'collisionStart', event => {
    if (event.pairs.some(pair => pair.bodyA.label === 'thing' && pair.bodyB.label === 'thing')) hit = true;
  });
  Matter.Body.setVelocity(physics.portableBodies.get(item), { x: 8, y: 0 });
  let bounced = false;
  for (let i = 0; i < 60; i++) {
    physics.step(PHYSICS_STEP_MS / 1000);
    if (hit && physics.portableBodies.get(item).velocity.x < 0) bounced = true;
  }
  assert.ok(hit);
  assert.ok(bounced);
});

test('an actor collider pushes a dynamic body', () => {
  const item = thing('chest', 48, 50);
  const actor = { id: 'walker', x: 26, y: 50, radius: 6 };
  const physics = createPhysics(Matter, { bounds, portables: [item], actors: [actor] });
  const box = physics.portableBodies.get(item), start = box.position.x;
  run(physics, 50, i => { actor.x = 26 + i * .45; });
  assert.ok(box.position.x > start + .5, [start, box.position.x]);
});

test('release velocity is capped', () => {
  const item = thing('cookie', 30, 50, 10, 10);
  const physics = createPhysics(Matter, { bounds, portables: [item] });
  const body = physics.portableBodies.get(item);
  physics.grab(body, { x: 30, y: 50 });
  physics.moveHeld({ x: 30, y: 50 }, 1000);
  physics.moveHeld({ x: 100, y: 90 }, 1100);
  const thrown = physics.releaseHeld(1100);
  assert.ok(Math.hypot(thrown.vx, thrown.vy) <= MAX_THROW_SPEED + .001, thrown);
});

test('resting bodies stay still without gravity', () => {
  const item = thing('rest', 50, 50);
  const physics = createPhysics(Matter, { bounds, portables: [item] });
  const body = physics.portableBodies.get(item);
  run(physics, 180);
  assert.ok(Math.abs(body.position.x - 50) < .01, body.position.x);
  assert.ok(Math.abs(body.position.y - 44) < .01, body.position.y);
  assert.ok(Math.abs(body.angle) < .001, body.angle);
});

test('ten dynamic bodies keep a small physics frame', () => {
  const items = Array.from({ length: 10 }, (_, i) => thing(`b${i}`, 20 + i * 7, 30 + (i % 3) * 15, 8, 8));
  const physics = createPhysics(Matter, { bounds, portables: items });
  items.forEach((item, i) => Matter.Body.setVelocity(physics.portableBodies.get(item), { x: i % 2 ? 1.5 : -1.5, y: .2 }));
  const started = performance.now();
  run(physics, 600);
  assert.ok(performance.now() - started < 1000, '600 fixed physics updates should fit the host budget');
});

test('the fixed step and seeded layout are reproducible', () => {
  const a = thing('same-a', 30, 30), b = thing('same-b', 60, 30);
  const p1 = createPhysics(Matter, { bounds, portables: [a, b] });
  const p2 = createPhysics(Matter, { bounds, portables: [{ ...a }, { ...b }] });
  assert.equal(p1.step(.01).steps, 0);
  assert.equal(p1.step(.007).steps, 1);
  p2.step(.017);
  assert.ok(Math.abs(p1.portableBodies.get(a).position.x - 30) < .01);
  assert.ok(Math.abs(p2.portableBodies.get([...p2.portableBodies.keys()][0]).position.x - 30) < .01);
});
