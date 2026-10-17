// The dialogue pool's budget: changes are gathered (debounce) and the calls per hour are capped. Fake claude (test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
Object.assign(process.env, { KRITZEL_POOL_DEBOUNCE_S: '0.05', KRITZEL_POOL_PER_HOUR: '2', KRITZEL_DIALOGUE_MODEL: 'claude-haiku-5-5' });
const { wantDialogues, situationChanges } = await import('./generate.mjs');

test('the moment changes the pool cares about', () => {
  const a = { carrying: [{ who: 'affe', what: 'Ball' }], thrown: [], night: 0.2, weather: [] };
  assert.deepEqual(situationChanges(null, a), ['affe carries Ball']);
  assert.deepEqual(situationChanges(a, a), []);
  assert.deepEqual(situationChanges(a, { ...a, carrying: [], night: 0.3 }), []);              // put down, a bit darker: nothing
  assert.deepEqual(situationChanges(a, { ...a, thrown: [{ who: 'affe', what: 'Ball', to: 'Maus' }], night: 0.6, weather: ['rain'] }),
    ['affe throws Ball', 'night falls', 'weather: rain']);
  assert.deepEqual(situationChanges({ ...a, weather: ['rain'] }, a), ['the weather clears']);
});

test('changes close together make one call, and no more than the hourly cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-budget-'));
  const lines = [], err = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const actor = (id, name) => `export const meta = { name: '${name}', drawing: 'x' };\nexport function build() { return { actors: [{ id: '${id}', name: '${name}', rig: {} }] }; }\n`;
    writeFileSync(join(dir, 'affe.js'), actor('affe', 'Affe'));
    writeFileSync(join(dir, 'maus.js'), actor('maus', 'Maus'));
    const opts = { thingsDir: dir }, wait = ms => new Promise(ok => setTimeout(ok, ms));
    wantDialogues(opts, 'new Affe'); wantDialogues(opts, 'night falls'); wantDialogues(opts, 'affe carries Ball');
    await wait(1500);
    wantDialogues(opts, 'new Maus');
    await wait(1500);
    wantDialogues(opts, 'weather: rain');
    await wait(500);
    const calls = lines.filter(l => /dialogues: call/.test(l));
    assert.equal(calls.length, 2);
    assert.match(calls[0], /call 1\/2 this hour \(new Affe, night falls, affe carries Ball\)/);
    assert.match(calls[1], /call 2\/2 this hour \(new Maus\)/);
    assert.ok(lines.some(l => /dialogues: 2 calls this hour, the next \(weather: rain\) in \d+s/.test(l)));
  } finally { console.error = err; rmSync(dir, { recursive: true, force: true }); }
});
