// A thing's own Ogg is written beside its module, and a failed sound render never blocks the thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
process.env.KRITZEL_PROVIDER = 'claude';
process.env.KRITZEL_TEXT_MODEL = 'claude-haiku-5-5';
delete process.env.KRITZEL_MODEL; delete process.env.KRITZEL_DRAFT_MODEL;
const { processTextRequest } = await import('./generate.mjs');

const lantern = `// parts: body = a short round base
export const meta = { name: 'Laterne', drawing: 'a lantern', paper: { x: 0.5, y: 0.5 } };
export function build(ctx) {
  const { THREE, world, mat } = ctx;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.8, 12), mat(0xffcc88)));
  world.add(g);
  return { actors: [], obstacles: [], spots: [] };
}`;

const dirs = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-sound-'));
  for (const d of ['things', 'reports', 'requests', 'sounds/things']) mkdirSync(join(dir, d), { recursive: true });
  return dir;
};
const request = (dir, id) => {
  writeFileSync(join(dir, 'requests', id + '.json'), JSON.stringify({ id, text: 'eine Laterne', mode: 'new' }));
  return join(dir, 'requests', id + '.json');
};
const fake = (dir, ok) => {
  const f = join(dir, ok ? 'fake-sound' : 'fake-sound-fails');
  writeFileSync(f, ok
    ? '#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "--out" ] && out=$2; shift; done\nprintf "OggS fake" > "$out"\n'
    : '#!/bin/sh\necho "no earshot here" >&2\nexit 1\n');
  chmodSync(f, 0o755);
  return f;
};

test('a written thing gets sounds/things/<base>.ogg and the report names it', async () => {
  const dir = dirs();
  process.env.KRITZEL_THING_SOUNDS = '1';
  process.env.KRITZEL_THING_SOUNDS_CMD = fake(dir, true);
  process.env.KRITZEL_THING_SOUNDS_SCRIPT = '/does/not/matter';
  try {
    writeFileSync(join(dir, 'reply.txt'), `### NEW\n${lantern}`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const r = await processTextRequest(request(dir, 'text-20261019-200000'), { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports') });
    assert.equal(r.error, undefined, r.error);
    assert.ok(existsSync(join(dir, 'things', 'laterne.js')));
    assert.ok(existsSync(join(dir, 'sounds', 'things', 'laterne.ogg')));
    assert.equal(readFileSync(join(dir, 'sounds', 'things', 'laterne.ogg'), 'utf8'), 'OggS fake');
    assert.equal(r.written[0].sound.file, 'sounds/things/laterne.ogg');
  } finally {
    for (const k of ['KRITZEL_THING_SOUNDS', 'KRITZEL_THING_SOUNDS_CMD', 'KRITZEL_THING_SOUNDS_SCRIPT', 'FAKE_CLAUDE_REPLY']) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sound render that fails is logged, and the thing is still written', async () => {
  const dir = dirs();
  process.env.KRITZEL_THING_SOUNDS = '1';
  process.env.KRITZEL_THING_SOUNDS_CMD = fake(dir, false);
  process.env.KRITZEL_THING_SOUNDS_SCRIPT = '/does/not/matter';
  try {
    writeFileSync(join(dir, 'reply.txt'), `### NEW\n${lantern}`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const r = await processTextRequest(request(dir, 'text-20261019-200001'), { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports') });
    assert.equal(r.error, undefined, r.error);
    assert.ok(existsSync(join(dir, 'things', 'laterne.js')));
    assert.equal(existsSync(join(dir, 'sounds', 'things', 'laterne.ogg')), false);
    assert.equal(r.written[0].sound, undefined);
  } finally {
    for (const k of ['KRITZEL_THING_SOUNDS', 'KRITZEL_THING_SOUNDS_CMD', 'KRITZEL_THING_SOUNDS_SCRIPT', 'FAKE_CLAUDE_REPLY']) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
});
