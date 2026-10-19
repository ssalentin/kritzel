// The sound bank's contract: one small Ogg per role, and the whole bank within its size budget.
// node --test viewer/test-sounds.mjs   (scripts/make-sounds.sh renders the files)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const viewer = dirname(fileURLToPath(import.meta.url));
const dir = join(viewer, 'sounds');
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

test('a new-world archive carries the sound bank with the page', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kritzel-bank-'));
  try {
    cpSync(viewer, join(tmp, 'viewer'), { recursive: true, filter: p => !p.includes('__pycache__') });
    mkdirSync(join(tmp, 'scripts'));
    cpSync(join(viewer, '..', 'scripts', 'newworld.sh'), join(tmp, 'scripts', 'newworld.sh'));
    execFileSync('bash', [join(tmp, 'scripts', 'newworld.sh'), 'qa'], { cwd: tmp, stdio: 'pipe' });
    const [archive] = readdirSync(join(tmp, 'worlds'));
    for (const f of files) {
      const archived = join(tmp, 'worlds', archive, 'sounds', f);
      assert.ok(existsSync(archived), `${f} is missing from ${archive}`);
      assert.deepEqual(readFileSync(archived), readFileSync(join(dir, f)), f);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
