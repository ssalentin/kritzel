// The tab's small 3D | Pixel choice: node --test viewer/test-pixel.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { PIXEL_KEY, readPixelMode, savePixelMode } from './pixel/mode.js';

const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('pixel mode starts in 3D and remembers the tab choice', () => {
  const tab = storage();
  assert.equal(readPixelMode(tab), false);
  savePixelMode(tab, true);
  assert.equal(tab.getItem(PIXEL_KEY), '1');
  assert.equal(readPixelMode(tab), true);
  savePixelMode(tab, false);
  assert.equal(readPixelMode(tab), false);
});

test('storage failures keep the viewer usable', () => {
  const blocked = { getItem() { throw new Error('private mode'); }, setItem() { throw new Error('private mode'); } };
  assert.equal(readPixelMode(blocked), false);
  assert.doesNotThrow(() => savePixelMode(blocked, true));
});
