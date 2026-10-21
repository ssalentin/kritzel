// Whole-strip frame selection: node --test viewer/test-pixel-animation.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripFrame } from './pixel/animation.js';

test('a four-frame walk strip selects four complete frames', () => {
  assert.deepEqual(stripFrame(112, 40, { frames: 4, fps: 10, state: 'move', now: 0 }),
    { count: 4, index: 0, width: 28, height: 40 });
  assert.equal(stripFrame(112, 40, { frames: 4, fps: 10, state: 'move', now: 100 }).index, 1);
  assert.equal(stripFrame(112, 40, { frames: 4, fps: 10, state: 'move', now: 250 }).index, 2);
  assert.equal(stripFrame(112, 40, { frames: 4, fps: 10, state: 'idle', now: 999 }).index, 0);
});

test('fly and hop strips use their declared whole-frame widths', () => {
  assert.equal(stripFrame(96, 32, { frames: 3, state: 'move', now: 200, fps: 10 }).width, 32);
  assert.equal(stripFrame(64, 48, { frames: 2, state: 'move', now: 200, fps: 10 }).width, 32);
});

test('missing or malformed frame metadata falls back to one whole image', () => {
  assert.deepEqual(stripFrame(32, 32, {}), { count: 1, index: 0, width: 32, height: 32 });
  assert.equal(stripFrame(100, 32, { frames: 3, state: 'move', now: 500 }).width, 100);
});
