// The render mode owns the world: 3D writes .js things, pixel writes JSON+pxl assets, and a switch
// during a model call aborts the outgoing mode's write.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
Object.assign(process.env, { KRITZEL_PROVIDER: 'claude', KRITZEL_THING_SOUNDS: '0', KRITZEL_THING_SPRITES: '0' });
delete process.env.KRITZEL_MODEL; delete process.env.KRITZEL_DRAFT_MODEL;
const modeDir = mkdtempSync(join(tmpdir(), 'kritzel-mode-'));
process.env.KRITZEL_WORLD_MODE = join(modeDir, 'world-mode.json');
const { readRenderMode } = await import('./mode.mjs');
const { processFrame, processTextRequest, processPixelFrame, spriteFor } = await import('./generate.mjs');
const { buildPng, spriteSource } = await import('../scripts/thing_sprite.mjs');
const { DRAGON } = await import('../scripts/sprite-examples.mjs');
after(() => rmSync(modeDir, { recursive: true, force: true }));

const mode = render => writeFileSync(process.env.KRITZEL_WORLD_MODE, JSON.stringify({ render }));
const dirs = () => {
  const d = mkdtempSync(join(tmpdir(), 'kritzel-routing-'));
  for (const p of ['viewer/things', 'viewer/pixel/things', 'frames/requests', 'frames/generated']) mkdirSync(join(d, p), { recursive: true });
  return d;
};
const tower = `// parts: body = a tall building
export const meta = { name: 'Turm', drawing: 'a tall grey tower', paper: { x: 0.5, y: 0.5 } };
export function build(ctx) {
  const { THREE, world, mat, shadowAll } = ctx;
  const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 2, 8), mat(0x999999))); g.position.y = 1;
  shadowAll(g); world.add(g); return { actors: [], obstacles: [{ x: 0, z: 0, r: 0.5 }], spots: [] };
}`;
const fakeSprite = dir => {
  const p = join(dir, 'fake-sprite');
  writeFileSync(p, `#!/bin/sh
out=""; report=""; file=""
while [ $# -gt 0 ]; do case "$1" in --out) out=$2; shift 2;; --report) report=$2; shift 2;; --file) file=$2; shift 2;; *) shift;; esac; done
base=$(basename "$file" .js)
mkdir -p "$out"
printf 'fake-png' > "$out/$base.png"
printf 'fake-source' > "$out/$base.px.js"
mkdir -p "$(dirname "$report")"; printf '{}' > "$report"
echo '{"ok":true,"buildMs":1,"cost":0.01,"model":"fake"}'
`);
  chmodSync(p, 0o755);
  return p;
};
const withSprite = (dir, fn) => {
  const oldCmd = process.env.KRITZEL_THING_SPRITES_CMD, oldScript = process.env.KRITZEL_THING_SPRITES_SCRIPT;
  Object.assign(process.env, { KRITZEL_THING_SPRITES_CMD: fakeSprite(dir), KRITZEL_THING_SPRITES_SCRIPT: '/does/not/matter' });
  return Promise.resolve(fn()).finally(() => {
    if (oldCmd === undefined) delete process.env.KRITZEL_THING_SPRITES_CMD; else process.env.KRITZEL_THING_SPRITES_CMD = oldCmd;
    if (oldScript === undefined) delete process.env.KRITZEL_THING_SPRITES_SCRIPT; else process.env.KRITZEL_THING_SPRITES_SCRIPT = oldScript;
  });
};

test('render mode defaults to 3d and accepts pixel', () => {
  rmSync(process.env.KRITZEL_WORLD_MODE, { force: true });
  assert.equal(readRenderMode(), '3d');
  mode('pixel'); assert.equal(readRenderMode(), 'pixel');
  writeFileSync(process.env.KRITZEL_WORLD_MODE, 'not json'); assert.equal(readRenderMode(), '3d');
});

test('typed 3d requests write a .js and no pixel thing', async () => {
  mode('3d');
  const d = dirs();
  writeFileSync(join(d, 'reply.txt'), `### NEW\n${tower}`);
  process.env.FAKE_CLAUDE_REPLY = join(d, 'reply.txt');
  try {
    writeFileSync(join(d, 'frames/requests/text-mode1.json'), JSON.stringify({ text: 'ein Turm', mode: 'new' }));
    const r = await processTextRequest(join(d, 'frames/requests/text-mode1.json'), { thingsDir: join(d, 'viewer/things'), reportsDir: join(d, 'frames/generated') });
    assert.equal(r.error, undefined, r.error);
    assert.ok(existsSync(join(d, 'viewer/things/turm.js')));
    assert.deepEqual(readdirSync(join(d, 'viewer/pixel/things')), []);
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(d, { recursive: true, force: true }); }
});

test('typed pixel requests write JSON+png/pxl and no 3D module', async () => {
  mode('pixel');
  const d = dirs();
  writeFileSync(join(d, 'split.txt'), JSON.stringify({ subjects: [
    { name: 'Drache', drawing: 'a friendly green dragon with wings and horns', kind: 'actor' },
  ] }));
  process.env.FAKE_CLAUDE_REPLY = join(d, 'split.txt');
  try {
    await withSprite(d, async () => {
      writeFileSync(join(d, 'frames/requests/text-mode2.json'), JSON.stringify({ text: 'ein Drache', mode: 'new' }));
      const r = await processTextRequest(join(d, 'frames/requests/text-mode2.json'), { thingsDir: join(d, 'viewer/things'), reportsDir: join(d, 'frames/generated') });
      assert.ok(!r.error, r.error);
      assert.deepEqual(readdirSync(join(d, 'viewer/things')), []);
      assert.deepEqual(readdirSync(join(d, 'viewer/pixel/things')).sort(), ['drache.json', 'drache.png', 'drache.px.js']);
      const j = JSON.parse(readFileSync(join(d, 'viewer/pixel/things/drache.json'), 'utf8'));
      assert.deepEqual([j.name, j.drawing, j.kind, j.sprite], ['Drache', 'a friendly green dragon with wings and horns', 'actor', 'drache.png']);
    });
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(d, { recursive: true, force: true }); }
});

test('typed pixel subjects split like 3D: Eiffelturm und Wolkenkratzer become two things', async () => {
  mode('pixel');
  const d = dirs();
  writeFileSync(join(d, 'split.txt'), JSON.stringify({ subjects: [
    { name: 'Eiffelturm', drawing: 'an Eiffel Tower with four legs, two platforms and a spire', kind: 'scenery' },
    { name: 'Wolkenkratzer', drawing: 'a tall skyscraper with rows of windows', kind: 'scenery' },
  ] }));
  process.env.FAKE_CLAUDE_REPLY = join(d, 'split.txt');
  try {
    await withSprite(d, async () => {
      writeFileSync(join(d, 'frames/requests/text-mode3.json'), JSON.stringify({ text: 'Eiffelturm und Wolkenkratzer', mode: 'new' }));
      const r = await processTextRequest(join(d, 'frames/requests/text-mode3.json'), { thingsDir: join(d, 'viewer/things'), reportsDir: join(d, 'frames/generated') });
      assert.ok(!r.error, r.error);
      assert.deepEqual(readdirSync(join(d, 'viewer/things')), []);
      const files = readdirSync(join(d, 'viewer/pixel/things')).filter(f => f.endsWith('.json')).sort();
      assert.deepEqual(files, ['eiffelturm.json', 'wolkenkratzer.json']);
      const things = files.map(f => JSON.parse(readFileSync(join(d, 'viewer/pixel/things', f), 'utf8')));
      assert.deepEqual(things.map(t => t.name).sort(), ['Eiffelturm', 'Wolkenkratzer']);
      assert.deepEqual(things.map(t => t.paper.x).sort(), [0.3, 0.7]);
      assert.ok(existsSync(join(d, 'viewer/pixel/things/eiffelturm.png')));
      assert.ok(existsSync(join(d, 'viewer/pixel/things/wolkenkratzer.png')));
      assert.equal(JSON.parse(readFileSync(join(d, 'frames/generated/text-mode3.json'), 'utf8')).written.length, 2);
    });
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(d, { recursive: true, force: true }); }
});

test('a pixel frame writes descriptions and sprites, not 3D modules', async () => {
  mode('pixel');
  const d = dirs();
  const frame = join(d, '20261021-210000.jpg');
  execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
  const list = { things: [
    { box: [0.1, 0.1, 0.3, 0.3], in_book: null, face: 'no face', what: 'the sun behind a rain cloud', de: 'eine Sonne', en: 'a sun', den: 'die Sonne', the: 'the sun', name_en: 'Sun' },
    { box: [0.4, 0.1, 0.6, 0.5], in_book: null, face: 'eyes above mouth', what: 'a girl in a wheelchair carrying a cookie', de: 'ein Mädchen', en: 'a girl', den: 'das Mädchen', the: 'the girl', name_en: 'Girl' },
    { box: [0.7, 0.1, 0.9, 0.5], in_book: null, face: 'eyes above mouth', what: 'a red panda in a tree', de: 'ein roter Panda', en: 'a red panda', den: 'den roten Panda', the: 'the red panda', name_en: 'Red Panda' },
  ] };
  writeFileSync(join(d, 'list.txt'), JSON.stringify(list));
  process.env.FAKE_CLAUDE_LIST = join(d, 'list.txt');
  try {
    await withSprite(d, async () => {
      const r = await processPixelFrame(frame, { pixelThingsDir: join(d, 'viewer/pixel/things'), reportsDir: join(d, 'frames/generated') });
      assert.equal(r.error, null, r.error);
      assert.deepEqual(readdirSync(join(d, 'viewer/things')), []);
      const files = readdirSync(join(d, 'viewer/pixel/things')).filter(f => f.endsWith('.json')).sort();
      assert.equal(files.length, 3);
      const drawings = files.map(f => JSON.parse(readFileSync(join(d, 'viewer/pixel/things', f), 'utf8'))).map(j => j.drawing).sort();
      assert.deepEqual(drawings, ['a girl in a wheelchair carrying a cookie', 'a red panda in a tree', 'the sun behind a rain cloud'].sort());
      for (const f of files) assert.ok(existsSync(join(d, 'viewer/pixel/things', f.replace(/\.json$/, '.png'))));
    });
  } finally { delete process.env.FAKE_CLAUDE_LIST; rmSync(d, { recursive: true, force: true }); }
});

test('a switch to pixel during a 3D model call aborts the 3D write', async () => {
  mode('3d');
  const d = dirs();
  const frame = join(d, '20261021-210001.jpg'), log = join(d, 'prompts.jsonl');
  execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
  writeFileSync(join(d, 'reply.txt'), `### NEW\n${tower}`);
  Object.assign(process.env, { FAKE_CLAUDE_REPLY: join(d, 'reply.txt'), FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_SLOW_TEXT: 'This image is the part of the paper', FAKE_CLAUDE_SLOW_MS: '300' });
  try {
    const p = processFrame(frame, { thingsDir: join(d, 'viewer/things'), reportsDir: join(d, 'frames/generated'), box: [100, 100, 200, 200] });
    for (let i = 0; i < 100 && !existsSync(log); i++) await new Promise(ok => setTimeout(ok, 20));
    assert.ok(existsSync(log), 'the 3D call never started');
    mode('pixel');
    const r = await p;
    assert.match(r.error, /render mode is pixel/);
    assert.deepEqual(readdirSync(join(d, 'viewer/things')), []);
  } finally {
    for (const k of ['FAKE_CLAUDE_REPLY', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SLOW_TEXT', 'FAKE_CLAUDE_SLOW_MS']) delete process.env[k];
    rmSync(d, { recursive: true, force: true });
  }
});

test('a 3D sprite job is not queued in pixel mode, and a started build cannot publish after the switch', async () => {
  mode('pixel');
  const d = dirs();
  try {
    const queued = await spriteFor('drache.js', 'Drache', 'a friendly dragon', 'actor', 'fly',
      join(d, 'viewer/things'), join(d, 'frames/generated'));
    assert.equal(queued, null);
    assert.deepEqual(readdirSync(join(d, 'viewer/things')), []);
    assert.equal(existsSync(join(d, 'viewer/pixel/sprites')), false);

    // the child build re-checks the mode just before publishing: a job started in 3D is refused
    const out = join(d, 'viewer/pixel/sprites');
    assert.throws(() => buildPng({ source: spriteSource('drache.js', 'drache', DRAGON), base: 'drache',
      outDir: out, requireMode: '3d' }), /render mode changed/);
    assert.equal(existsSync(join(out, 'drache.png')), false);
    assert.equal(existsSync(join(out, 'drache.px.js')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
