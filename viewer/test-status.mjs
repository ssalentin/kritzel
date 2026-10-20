// The pill's text choice, without a DOM: node --test viewer/test-status.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { documentElement: {} };                       // i18n.js touches it at import
globalThis.localStorage = { getItem: () => 'en', setItem() {} };     // and reads the language there
const { pillView } = await import('./status.js');

const capture = (kind, at = 100) => ({ alive: true, state: 'watching', last: { at, kind, frame: 'f' } });
const building = { alive: true, state: 'building', since: 100, now: null };

test('a fresh change kind is shown while generate is already building', () => {
  const v = pillView({ st: { capture: capture('coloured_in'), generate: building }, now: 101 });
  assert.equal(v.text, '✏️ Colouring in …');
});

test('after its short window the build message takes over', () => {
  const v = pillView({ st: { capture: capture('coloured_in'), generate: building }, now: 103 });
  assert.match(v.text, /what could that be/);
});

test('a frame without a kind still shows the build message', () => {
  const v = pillView({ st: { capture: capture(null), generate: building }, now: 101 });
  assert.match(v.text, /what could that be/);
});

test('an unchanged label is not shown as a kind', () => {
  const v = pillView({ st: { capture: capture('unchanged'), generate: { alive: false } }, now: 101 });
  assert.equal(v.text, '✏️ Oh, something is happening …');
});

test('camera state is not narrated by the pill', () => {
  for (const state of ['camera-off', 'no-camera', 'no-paper', 'moving']) {
    const v = pillView({ st: { capture: { alive: true, state } }, now: 101 });
    assert.equal(v.text, '', state);
  }
});
