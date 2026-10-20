// A provider call that dies after streaming part of a module must not leave a half-written thing:
// processFrame reports the failure and writes nothing (fake claude, a private PATH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.KRITZEL_PROVIDER = 'claude';
delete process.env.KRITZEL_MODEL; delete process.env.KRITZEL_DRAFT_MODEL;
const { processFrame } = await import('./generate.mjs');

test('a provider call killed after partial text fails the frame and writes no thing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-provider-fail-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  // stream one complete-looking section and then die before a result
  writeFileSync(fake, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta',
    delta: { type: 'text_delta', text: '### NEW\\nexport const meta = { name: \\'Halb\\' };\\n' } } }));
  process.exitCode = 1;
});
`);
  chmodSync(fake, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  try {
    for (const d of ['things', 'reports']) mkdirSync(join(dir, d));
    const frame = join(dir, '20261020-103000.jpg');
    execFileSync('convert', ['-size', '640x480', 'xc:white', frame]);
    const r = await processFrame(frame, { thingsDir: join(dir, 'things'), reportsDir: join(dir, 'reports'), box: [100, 100, 200, 200] });
    assert.match(r.error, /without a result|exited 1/);
    assert.deepEqual(readdirSync(join(dir, 'things')), []);
    const saved = JSON.parse(readFileSync(join(dir, 'reports', '20261020-103000.json'), 'utf8'));
    assert.match(saved.error, /without a result|exited 1/);
    assert.deepEqual(saved.written, []);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
