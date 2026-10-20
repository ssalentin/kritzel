// The build list in generate's status (generate.things) for the viewer's queue (fake claude, test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
process.env.KRITZEL_PROVIDER = 'claude';
process.env.KRITZEL_THINGS_LINGER_MS = '200';
delete process.env.KRITZEL_DRAFT_MODEL; delete process.env.KRITZEL_MODEL;
const { processFrame } = await import('./generate.mjs');

test('each drawing of the frame moves through listed, building and done, and the list goes after a while', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-things-'));
  try {
    for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
    const frame = join(dir, '20261017-120000.jpg');
    execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
    const example = readFileSync(join(import.meta.dirname, 'examples', 'schnecke.js'), 'utf8');
    writeFileSync(join(dir, 'reply.txt'), `SEEN: [{"de": "eine Schnecke", "en": "a snail", "den": "die Schnecke", "the": "the snail", "name_en": "Snail"}, {"de": "ein Wort", "en": "a word", "den": "das Wort", "the": "the word", "name_en": "Word"}]
### NEW
${example}
### NEW
export const meta = { name: 'Sqichy-Wort', drawing: 'the handwritten word Sqichy' };
export function build() { return { actors: [] }; }`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const seen = [];
    await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [100, 100, 200, 200], onProgress: p => { if (p.things) seen.push(JSON.parse(JSON.stringify(p.things))); } });
    const last = seen.at(-1);
    assert.deepEqual(last.map(t => [t.name.de, t.state]), [['eine Schnecke', 'done'], ['ein Wort', 'failed']]);
    assert.equal(last[0].file, 'schnecke.js');
    assert.ok(seen.some(l => l[0]?.state === 'listed') || seen.some(l => l[0]?.state === 'building'));
    await new Promise(ok => setTimeout(ok, 400));
    assert.deepEqual(seen.at(-1), []);                                       // gone after the linger
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(dir, { recursive: true, force: true }); }
});

test('a frame that ends in an error still marks its rows failed and clears the list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-things-'));
  try {
    for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
    const frame = join(dir, '20261017-120001.jpg');
    execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
    writeFileSync(join(dir, 'reply.txt'), `SEEN: [{"de": "eine Maus", "en": "a mouse", "den": "die Maus", "the": "the mouse", "name_en": "Mouse"}, {"de": "ein Hund", "en": "a dog", "den": "den Hund", "the": "the dog", "name_en": "Dog"}]\nno sections here`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const seen = [];
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [100, 100, 200, 200], onProgress: p => { if (p.things) seen.push(JSON.parse(JSON.stringify(p.things))); } });
    assert.ok(r.error);
    assert.deepEqual(seen.at(-1).map(t => t.state), ['failed', 'failed']);
    await new Promise(ok => setTimeout(ok, 400));
    assert.deepEqual(seen.at(-1), []);
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(dir, { recursive: true, force: true }); }
});

const tower = (name, x, y, color) => `// parts: body = a tall building
export const meta = { name: '${name}', drawing: 'a tall ${name}', paper: { x: ${x}, y: ${y} } };
export function build(ctx) {
  const { THREE, world, mat, shadowAll } = ctx;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 2.4, 8), mat(0x${color})));
  g.position.y = 1.2;
  shadowAll(g); world.add(g);
  return { actors: [], obstacles: [{ x: 0, z: 0, r: 0.5 }], spots: [] };
}`;

test('two separated buildings on one sheet become two things; one connected object stays one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-split-'));
  try {
    for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
    const frame = join(dir, '20261017-130000.jpg');
    // a fixture sheet with two separated rectangles (a fake model answers; the frame is the recorded input)
    execFileSync('convert', ['-size', '640x480', 'xc:white', '-fill', 'black',
      '-draw', 'rectangle 100,100 250,300', '-draw', 'rectangle 350,100 500,300', frame]);
    writeFileSync(join(dir, 'reply.txt'), `### NEW
${tower('Eiffelturm', 0.3, 0.45, 'b08a5a')}
### NEW
${tower('Wolkenkratzer', 0.7, 0.45, '8a9ab0')}`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'reply.txt');
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [80, 80, 440, 240] });
    assert.equal(r.error, undefined, r.error);
    // section writes run concurrently in the frame path: the completion order is not a promise
    assert.deepEqual(r.written.map(w => w.name).sort(), ['Eiffelturm', 'Wolkenkratzer']);
    assert.deepEqual(r.written.map(w => w.file).sort(), ['eiffelturm.js', 'wolkenkratzer.js']);
    assert.deepEqual(readdirSync(join(dir, 'things')).filter(f => f.endsWith('.js')).sort(), ['eiffelturm.js', 'wolkenkratzer.js']);
    const code = r.written.map(w => readFileSync(join(dir, 'things', w.file), 'utf8')).join('\n');
    assert.match(code, /paper: \{ x: 0\.3, y: 0\.45 \}/);
    assert.match(code, /paper: \{ x: 0\.7, y: 0\.45 \}/);

    // the same connected object (the snail) stays one module
    const one = join(dir, 'one.jpg');
    execFileSync('convert', ['-size', '640x480', 'xc:white', one]);
    for (const d of ['one-things', 'one-reports']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'one.txt'), `### NEW
${readFileSync(join(import.meta.dirname, 'examples', 'schnecke.js'), 'utf8')}`);
    process.env.FAKE_CLAUDE_REPLY = join(dir, 'one.txt');
    const r1 = await processFrame(one, { thingsDir: join(dir, 'one-things'), reportsDir: join(dir, 'one-reports'), box: [100, 100, 200, 200] });
    assert.equal(r1.error, undefined, r1.error);
    assert.deepEqual(r1.written.map(w => w.file), ['schnecke.js']);
  } finally { delete process.env.FAKE_CLAUDE_REPLY; rmSync(dir, { recursive: true, force: true }); }
});
