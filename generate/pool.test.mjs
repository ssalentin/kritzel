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
