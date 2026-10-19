// Figure→thing carry judgment: the size fallback, the session cache and the portable goal.
// node --test viewer/test-carry.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { documentElement: {} };
globalThis.localStorage = { getItem: () => 'en', setItem() {} };

let calls = 0, reply = { ok: true, can: true };
globalThis.fetch = async () => { calls++; return { json: async () => reply }; };
const { localCan, canCarry, portable } = await import('./sim-extra.js');
const tick = () => new Promise(ok => setTimeout(ok, 10));

test('the size fallback allows a mouse a cookie and refuses it the chest', () => {
  assert.equal(localCan({ height: 0.25 }, { r: 0.15, top: 0.3 }), true);
  assert.equal(localCan({ height: 0.28 }, { r: 0.3, top: 0.28 }), true);    // a small cookie, footprint clamped at 0.3
  assert.equal(localCan({ height: 0.25 }, { r: 0.6, top: 1.2 }), false);
  assert.equal(localCan({ height: 1.1 }, { r: 0.6, top: 1.2 }), true);
  assert.equal(localCan({ height: 0.9 }, { r: 0.6, top: 1.2 }), false);
});

test('a pair is asked once and a no answer sticks', async () => {
  calls = 0; reply = { ok: true, can: false };
  const a = { kind: 'maus-b', name: 'Maus', height: 0.25 };
  const chest = { name: 'Truhe-b', r: 0.6, top: 1.2 };
  assert.equal(canCarry(a, chest), true);                 // optimistic while the ask is in flight
  await tick();
  assert.equal(canCarry(a, chest), false);
  assert.equal(canCarry({ kind: 'maus-b', name: 'Maus', height: 0.3 }, chest), false);
  assert.equal(calls, 1);
});

test('a failed ask falls back to the size rule', async () => {
  calls = 0; reply = { ok: false };
  const mouse = { kind: 'maus-c', name: 'Maus', height: 0.25 };
  const chest = { name: 'Truhe-c', r: 0.6, top: 1.2 };
  canCarry(mouse, chest); await tick();
  assert.equal(canCarry(mouse, chest), false);
  assert.equal(calls, 1);
});

function fakeApi(a, it) {
  return { now: () => 0, step: () => true, say() {}, line: () => '', nearest: () => ({ x: 0, y: 0 }), R: () => 0.5,
    busy() {}, spots: () => [it], actors: () => [a], spotCell: () => null };
}
function actor(kind, height) {
  return { id: kind, name: 'Figur', kind, height, radius: 0.4, pos: { x: 0, z: 0 }, cell: { x: 0, y: 0 }, goal: null, traits: { curiosity: 0.6 } };
}

test('the portable goal refuses a chest and keeps the thing on the page', async () => {
  calls = 0; reply = { ok: true, can: false };
  const a = actor('maus-d', 0.25), chest = { kind: 'portable', name: 'Truhe-d', x: 0, z: 0, r: 0.6, top: 1.2, carrier: null };
  canCarry(a, chest); await tick();
  a.goal = { type: 'pick', spot: chest };
  portable(a, a.goal, fakeApi(a, chest));
  assert.equal(chest.carrier, null);
  assert.equal(a.goal, null);
});

test('the portable goal picks up a cookie', async () => {
  calls = 0; reply = { ok: true, can: true };
  const a = actor('maus-e', 0.25), keks = { kind: 'portable', name: 'Keks-e', x: 0, z: 0, r: 0.15, top: 0.3, carrier: null };
  canCarry(a, keks); await tick();
  a.goal = { type: 'pick', spot: keks };
  portable(a, a.goal, fakeApi(a, keks));
  assert.equal(keks.carrier, a);
  assert.equal(a.goal.type, 'carry');
});

test('a denied item already in the hands is dropped', async () => {
  calls = 0; reply = { ok: true, can: false };
  const a = actor('maus-f', 0.25), chest = { kind: 'portable', name: 'Truhe-f', x: 0, z: 0, r: 0.6, top: 1.2, carrier: a };
  canCarry(a, chest); await tick();
  a.goal = { type: 'carry', item: chest };
  portable(a, a.goal, fakeApi(a, chest));
  assert.equal(chest.carrier, null);
  assert.equal(a.goal, null);
});
