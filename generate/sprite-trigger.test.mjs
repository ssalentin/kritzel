// The generation hook spawns the sprite job in the background and logs its result; a fake command
// here writes the expected files without a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.KRITZEL_PROVIDER = 'claude';
delete process.env.KRITZEL_MODEL; delete process.env.KRITZEL_DRAFT_MODEL;
const { spriteFor } = await import('./generate.mjs');

test('a written thing queues a background sprite job and its files appear', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-sprite-trigger-'));
  const fake = join(dir, 'fake-sprite');
  writeFileSync(fake, `#!/bin/sh
out=""; report=""; file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out=$2; shift 2;;
    --report) report=$2; shift 2;;
    --file) file=$2; shift 2;;
    *) shift;;
  esac
done
base=$(basename "$file" .js)
mkdir -p "$out"
printf 'fake-png' > "$out/$base.png"
printf 'fake-source' > "$out/$base.px.js"
mkdir -p "$(dirname "$report")"
printf '{}' > "$report"
echo '{"ok":true,"buildMs":2,"cost":0.0001}'
`);
  chmodSync(fake, 0o755);
  const oldCmd = process.env.KRITZEL_THING_SPRITES_CMD, oldScript = process.env.KRITZEL_THING_SPRITES_SCRIPT;
  const oldOn = process.env.KRITZEL_THING_SPRITES;
  process.env.KRITZEL_THING_SPRITES = '1';
  process.env.KRITZEL_THING_SPRITES_CMD = fake;
  process.env.KRITZEL_THING_SPRITES_SCRIPT = '/does/not/matter';
  try {
    const viewer = join(dir, 'viewer');
    mkdirSync(join(viewer, 'things'), { recursive: true });
    const r = await spriteFor('drache.js', 'Drache', 'a friendly dragon', 'actor', 'fly',
      join(viewer, 'things'), join(dir, 'frames', 'generated'));
    assert.equal(r.ok, true);
    assert.equal(readFileSync(join(viewer, 'pixel', 'sprites', 'drache.png'), 'utf8'), 'fake-png');
    assert.equal(readFileSync(join(viewer, 'pixel', 'sprites', 'drache.px.js'), 'utf8'), 'fake-source');
    assert.ok(existsSync(join(dir, 'frames', 'generated', 'drache.sprite.json')));
  } finally {
    if (oldCmd === undefined) delete process.env.KRITZEL_THING_SPRITES_CMD; else process.env.KRITZEL_THING_SPRITES_CMD = oldCmd;
    if (oldScript === undefined) delete process.env.KRITZEL_THING_SPRITES_SCRIPT; else process.env.KRITZEL_THING_SPRITES_SCRIPT = oldScript;
    if (oldOn === undefined) delete process.env.KRITZEL_THING_SPRITES; else process.env.KRITZEL_THING_SPRITES = oldOn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a newer write kills a running old sprite job; the final file is the newer drawing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-sprite-race-'));
  const fake = join(dir, 'fake-race');
  writeFileSync(fake, `#!/bin/sh
out=""; report=""; file=""; drawing=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out=$2; shift 2;;
    --report) report=$2; shift 2;;
    --file) file=$2; shift 2;;
    --drawing) drawing=$2; shift 2;;
    *) shift;;
  esac
done
base=$(basename "$file" .js)
case "$drawing" in
  first) sleep 0.4;;
  second) sleep 0.05;;
esac
mkdir -p "$out"
printf '%s' "$drawing" > "$out/$base.png"
printf 'source-%s' "$drawing" > "$out/$base.px.js"
mkdir -p "$(dirname "$report")"
printf '{}' > "$report"
echo '{"ok":true,"buildMs":1,"cost":0}'
`);
  chmodSync(fake, 0o755);
  const oldCmd = process.env.KRITZEL_THING_SPRITES_CMD, oldScript = process.env.KRITZEL_THING_SPRITES_SCRIPT;
  const oldOn = process.env.KRITZEL_THING_SPRITES;
  Object.assign(process.env, { KRITZEL_THING_SPRITES: '1', KRITZEL_THING_SPRITES_CMD: fake,
    KRITZEL_THING_SPRITES_SCRIPT: '/does/not/matter' });
  try {
    const viewer = join(dir, 'viewer');
    mkdirSync(join(viewer, 'things'), { recursive: true });
    const first = spriteFor('drache.js', 'Drache', 'first', 'actor', 'fly', join(viewer, 'things'), join(dir, 'r'));
    const second = spriteFor('drache.js', 'Drache', 'second', 'actor', 'fly', join(viewer, 'things'), join(dir, 'r'));
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.superseded, true);
    assert.equal(b.ok, true);
    assert.equal(readFileSync(join(viewer, 'pixel', 'sprites', 'drache.png'), 'utf8'), 'second');
  } finally {
    if (oldCmd === undefined) delete process.env.KRITZEL_THING_SPRITES_CMD; else process.env.KRITZEL_THING_SPRITES_CMD = oldCmd;
    if (oldScript === undefined) delete process.env.KRITZEL_THING_SPRITES_SCRIPT; else process.env.KRITZEL_THING_SPRITES_SCRIPT = oldScript;
    if (oldOn === undefined) delete process.env.KRITZEL_THING_SPRITES; else process.env.KRITZEL_THING_SPRITES = oldOn;
    rmSync(dir, { recursive: true, force: true });
  }
});
