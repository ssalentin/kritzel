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
