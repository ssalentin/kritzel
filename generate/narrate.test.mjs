// The status pill's narration (#18): what the reply so far tells the child, filtered for children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrate, seenOf, nowOf, whyOf, parseReply } from './generate.mjs';

const SEEN = 'SEEN: [{"de": "ein Affe", "en": "a monkey", "den": "den Affen", "the": "the monkey", "name_en": "Monkey"}, {"de": "ein Baum", "en": "a tree", "den": "den Baum", "the": "the tree", "name_en": "Tree"}]\n';

test('seen once the SEEN line is complete, now from the sections begun', () => {
  assert.deepEqual(narrate('SEEN: [{"de": "ein Af').seen, []);
  const n = narrate(SEEN + '### NEW\n// parts: body = ');
  assert.deepEqual(seenOf(n.seen), [{ de: 'ein Affe', en: 'a monkey' }, { de: 'ein Baum', en: 'a tree' }]);
  assert.equal(n.begun, 1);
  assert.deepEqual(nowOf(n.seen[n.begun - 1]), { de: 'den Affen', en: 'the monkey' });
  assert.equal(narrate(SEEN + '### NEW\nx\n### UPDATE baum.js\ny').begun, 2);
  assert.equal(nowOf(undefined), null);
});

test('model text that fails the child-safe filter is left out', () => {
  const bad = 'SEEN: [{"de": "ein toter Vogel", "en": "a dead bird"}, {"de": "eine Katze", "en": "a cat"}]\n';
  assert.deepEqual(seenOf(narrate(bad).seen), [{ de: 'eine Katze', en: 'a cat' }]);
  assert.equal(whyOf('scribble | nothing\nKIDS: {"de": "Du bist dumm.", "en": "Just lines."}'), null);
  assert.deepEqual(whyOf('scribble | nothing\nKIDS: {"de": "Ich sehe nur Striche.", "en": "I only see lines."}'), { de: 'Ich sehe nur Striche.', en: 'I only see lines.' });
  assert.equal(whyOf('scribble | nothing'), null);
  assert.deepEqual(seenOf(narrate('SEEN: not json\n').seen), []);
});

test('the SEEN line does not disturb the sections', () => {
  const s = parseReply(SEEN + '### NEW\nexport const meta = {};\n### UNCLEAR\na dot | noise\nKIDS: {"de": "Nur ein Punkt.", "en": "Just a dot."}');
  assert.deepEqual(s.map(x => x.kind), ['NEW', 'UNCLEAR']);
  assert.equal(parseReply(SEEN + 'export const meta = { name: "A" };\nexport function build(ctx) {}')[0].body.startsWith('export const meta'), true);
});
