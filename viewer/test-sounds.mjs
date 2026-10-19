// The sound bank's contract: one small Ogg per role, and the whole bank within its size budget.
// node --test viewer/test-sounds.mjs   (scripts/make-sounds.sh renders the files)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'sounds');
const ROLES = ['arrival', 'page-turn', 'tap', 'giggle', 'sparkle', 'rain', 'thunder', 'new-world', 'typed-arrival'];
const files = readdirSync(dir).filter(f => f.endsWith('.ogg')).sort();

test('the bank has one Ogg file per role', () => {
  assert.deepEqual(files, ROLES.map(r => r + '.ogg').sort());
  for (const f of files) {
    assert.equal(readFileSync(join(dir, f)).subarray(0, 4).toString('latin1'), 'OggS', f);
    assert.ok(statSync(join(dir, f)).size > 1000, f + ' is empty');
  }
});

test('the whole bank stays under 300 KB', () => {
  const total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  assert.ok(total < 300 * 1024, `bank is ${total} bytes`);
});
