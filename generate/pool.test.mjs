// The watcher remakes the dialogue pool at start when it was made for another cast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
