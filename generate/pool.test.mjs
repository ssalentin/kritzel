// The watcher remakes the dialogue pool at start when it was made for another cast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { poolIsStale } from './generate.mjs';

const actor = (id, name) => `export const meta = { name: '${name}', drawing: 'x' };\nexport function build(ctx) { return { actors: [{ id: '${id}', name: '${name}', rig: {} }] }; }\n`;

test('the pool is stale when missing or made for another cast', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-pool-'));
  try {
    writeFileSync(join(dir, 'affe.js'), actor('affe', 'Affe'));
    assert.equal(await poolIsStale(dir), false);                       // one character: no pool at all
    writeFileSync(join(dir, 'maus.js'), actor('maus', 'Maus'));
    assert.equal(await poolIsStale(dir), true);                        // missing
    writeFileSync(join(dir, 'dialogues.json'), JSON.stringify({ cast: ['Affe'], dialogues: [] }));
    assert.equal(await poolIsStale(dir), true);                        // made before the mouse came
    writeFileSync(join(dir, 'dialogues.json'), JSON.stringify({ cast: ['Affe', 'Maus'], dialogues: [] }));
    assert.equal(await poolIsStale(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the cast finds actors written with other fields between id and name, in either order', async () => {
  const { castOf } = await import('./dialogues.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-cast-'));
  try {
    writeFileSync(join(dir, 'affe.js'), actor('affe', 'Affe'));
    writeFileSync(join(dir, 'kroete.js'), `export const meta = { name: 'Schildkröte', drawing: 'a turtle' };\nexport function build() { return { actors: [{\n  id: 'schildkroete', move: 'crawl', name: 'Schildkröte', start: [1.8, 0.5], speed: 0.4 }] }; }\n`);
    writeFileSync(join(dir, 'vogel.js'), `export const meta = { name: 'Vogel', drawing: 'x' };\nexport function build() { return { actors: [{ name: "Vogel mit Augen", move: 'fly', id: 'vogel' }] }; }\n`);
    writeFileSync(join(dir, 'haus.js'), `export const meta = { name: 'Haus', drawing: 'x' };\nexport function build() { return { actors: [] }; }\n`);
    assert.deepEqual(castOf(dir).map(c => [c.id, c.name]), [['affe', 'Affe'], ['schildkroete', 'Schildkröte'], ['vogel', 'Vogel mit Augen']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a persona keeps only what the sim can use: known names, an agreed hobby, safe lines in both languages', async () => {
  const { cleanPersona } = await import('./dialogues.mjs');
  const refs = new Set(['baum', 'maus', 'affe']);
  const p = cleanPersona({ favourite: 'Baum', likes: ['Maus', 'Mond', 'affe', 'Maus', 'Baum'], fears: ['Katze'], hobby: 'sing',
    lines: { de: ['Ich mag den Baum.', 'Du bist dumm!', 'Hallo!'], en: ['I like the tree.', 'Hi!'] } }, refs);
  assert.deepEqual(p, { favourite: 'Baum', likes: ['Maus', 'affe', 'Maus'], fears: [], hobby: 'wander', lines: { de: ['Ich mag den Baum.', 'Hallo!'], en: ['I like the tree.', 'Hi!'] } });
  assert.equal(cleanPersona('nope', refs), null);
});

test('when keeps only the keys the sim evaluates, and new only for things', async () => {
  const { cleanWhen } = await import('./dialogues.mjs');
  const refs = new Set(['baum', 'affe']), things = new Set(['baum']);
  assert.deepEqual(cleanWhen({ near: 'Baum', carrying: true, night: 0.66, weather: 'rain', new: 'Baum', mood: 'happy' }, refs, things),
    { near: 'Baum', carrying: true, night: 0.66, weather: 'rain', new: 'Baum' });
  assert.equal(cleanWhen({ near: 'Mond', carrying: 'yes', night: 2, weather: 'fog', new: 'Affe' }, refs, things), null);
});

test('the pool call keeps old personas, writes new ones, and maps actor ids in dialogues back to names', async () => {
  const { makePool } = await import('./dialogues.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-pool-'));
  const bin = join(import.meta.dirname, 'test-bin'), path = process.env.PATH;
  process.env.PATH = bin + ':' + path;
  try {
    writeFileSync(join(dir, 'affe.js'), actor('affe', 'Affe'));
    writeFileSync(join(dir, 'maus.js'), actor('maus', 'Maus'));
    writeFileSync(join(dir, 'baum.js'), `export const meta = { name: 'Baum', drawing: 'a tree' };\nexport function build() { return { actors: [] }; }\n`);
    const old = { favourite: 'Baum', likes: [], fears: [], hobby: 'guard', lines: { de: [], en: [] } };
    writeFileSync(join(dir, 'dialogues.json'), JSON.stringify({ personas: { affe: old, gone: old }, dialogues: [] }));
    writeFileSync(join(dir, 'reply.txt'), JSON.stringify({
      personas: { affe: { hobby: 'nap' }, maus: { favourite: 'Baum', likes: ['Affe'], fears: [], hobby: 'collect', lines: { de: ['Piep!'], en: ['Squeak!'] } } },
      dialogues: [{ between: ['affe', 'maus'], when: { near: 'Baum', mood: 'x' }, end: null, turns: [{ who: 'affe', de: 'Hallo Maus!', en: 'Hi mouse!' }, { who: 'maus', de: 'Hallo Affe!', en: 'Hi monkey!' }] }] }));
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const r = await makePool({ thingsDir: dir, model: 'claude-haiku-5-5', reason: 'test' });
    const j = JSON.parse(readFileSync(join(dir, 'dialogues.json'), 'utf8'));
    assert.deepEqual(j.personas.affe, old);                                // kept: not rewritten by the reply
    assert.equal(j.personas.maus.hobby, 'collect');
    assert.equal(j.personas.gone, undefined);                              // its figure left the book
    assert.deepEqual(j.dialogues[0].between, ['Affe', 'Maus']);
    assert.deepEqual(j.dialogues[0].when, { near: 'Baum' });
    assert.equal(j.reason, 'test');
    assert.equal(r.written, 1);
  } finally { process.env.PATH = path; delete process.env.FAKE_CLAUDE_REPLY; rmSync(dir, { recursive: true, force: true }); }
});
