// Every frame's report says where its time went (timing), against a fake claude (test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
delete process.env.KRITZEL_MODEL;
const { processFrame } = await import('./generate.mjs');

test('the report has the time of each stage and of each call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-timing-'));
  try {
    for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
    const frame = join(dir, '20261017-120000.jpg');
    execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
    const example = readFileSync(join(import.meta.dirname, 'examples', 'schnecke.js'), 'utf8');
    writeFileSync(join(dir, 'reply.txt'), `SEEN: [{"de": "eine Schnecke", "en": "a snail", "den": "die Schnecke", "the": "the snail", "name_en": "Snail"}]\n### NEW\n${example}`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [100, 100, 200, 200] });
    assert.equal(r.error, undefined);
    assert.equal(readdirSync(join(dir, 'things')).length, 1);
    const saved = JSON.parse(readFileSync(join(dir, 'reports', '20261017-120000.json'), 'utf8'));
    const t = saved.timing;
    for (const k of ['waited', 'things', 'crop', 'firstWritten', 'done']) assert.equal(typeof t[k], 'number', k);
    assert.ok(t.things <= t.crop && t.crop <= t.firstWritten && t.firstWritten <= t.done);
    assert.equal(typeof saved.calls[0].at, 'number');
    assert.equal(saved.calls[0].endedAt, undefined);
    assert.equal(saved.written[0].at, t.firstWritten);
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(dir, { recursive: true, force: true }); }
});

test('a new thing whose name is in the book already gets a number, in its meta and its actor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-names-'));
  try {
    for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
    const example = readFileSync(join(import.meta.dirname, 'examples', 'schnecke.js'), 'utf8');
    writeFileSync(join(dir, 'things', 'schnecke.js'), example);
    const frame = join(dir, '20261017-120001.jpg');
    execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
    writeFileSync(join(dir, 'reply.txt'), `### NEW\n${example.replace("id: 'schnecke'", "id: 'schnecke-zwei'")}`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [100, 100, 200, 200] });
    assert.equal(r.written[0]?.name, 'Schnecke 2', JSON.stringify(r.rejected));
    const code = readFileSync(join(dir, 'things', r.written[0].file), 'utf8');
    assert.ok(!/name:\s*'Schnecke'/.test(code) && /name:\s*'Schnecke 2'/.test(code));
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(dir, { recursive: true, force: true }); }
});

test('a drawing of spheres gets one fix call for silhouettes, then is taken as it is (a snowman is spheres)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-blobs-'));
  try {
    for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
    const frame = join(dir, '20261017-120002.jpg');
    execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
    const snowman = `// parts: base = a big ball\n// parts: middle = a smaller ball on it\n// parts: head = a small ball on top\n// parts: buttons = three small dots down the front
export const meta = { name: 'Schneemann', drawing: 'a snowman of three balls', paper: { x: 0.5, y: 0.5 } };
export function build(ctx) {
  const { THREE, world, mat, shadowAll } = ctx;
  const g = new THREE.Group();
  for (const [r, y] of [[0.6, 0.6], [0.45, 1.4], [0.3, 2.0]]) { const b = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat(0xffffff)); b.position.y = y; g.add(b); }
  for (const y of [1.3, 1.45, 1.6]) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), mat(0x222222)); d.position.set(0, y, 0.44); g.add(d); }
  shadowAll(g); world.add(g);
  return { actors: [], obstacles: [{ x: 0, z: 0, r: 0.6 }], spots: [] };
}`;
    writeFileSync(join(dir, 'reply.txt'), `### NEW\n${snowman}`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [100, 100, 200, 200] });
    assert.equal(r.written[0]?.name, 'Schneemann', JSON.stringify(r.rejected));
    const fixes = r.calls.filter(c => c.fix);
    assert.equal(fixes.length, 1);
    assert.match(fixes[0].fixing.join(' '), /spheres and boxes/);
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(dir, { recursive: true, force: true }); }
});
