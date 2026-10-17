// The build list in generate's status (generate.things) for the viewer's queue (fake claude, test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
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
