// The pi backend (pi.mjs) and its fallback in oneShot, against a fake pi and claude (test-bin/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
process.env.PATH = join(import.meta.dirname, 'test-bin') + ':' + process.env.PATH;
process.env.KRITZEL_PROVIDER = 'pi';
const { oneShot } = await import('./claude.mjs');
const M = 'fake/model', img = Buffer.from('jpeg');

test('a pi model streams its reply, and the warm process is reused with a fresh session', async () => {
  process.env.FAKE_PI = 'ok';
  const seen = [];
  const a = await oneShot({ system: 'S1', text: 'hi', images: [img], model: M, onText: t => seen.push(t) });
  assert.equal(a.text, 'Hello (call 1, 1 image) world');
  assert.deepEqual(seen, ['Hello (call 1, 1 image) ', 'Hello (call 1, 1 image) world']);
  assert.equal(a.cost, 0.001);
  const b = await oneShot({ system: 'S1', text: 'hi', images: [], model: M });
  assert.equal(b.text, 'Hello (call 2, 0 image) world');            // the same process, second call
});

test('an aborted pi call resolves with the text so far', async () => {
  process.env.FAKE_PI = 'slow';
  const ac = new AbortController();
  const r = await oneShot({ system: 'S2', text: 'go', images: [], model: M, signal: ac.signal, onText: t => { if (t.length >= 5) ac.abort(); } });
  assert.equal(r.aborted, true);
  assert.ok(r.text.length >= 5);
});

test('a pi call that fails before any text goes to the Claude fallback', async () => {
  for (const mode of ['error', 'die']) {
    process.env.FAKE_PI = mode;
    const r = await oneShot({ system: 'S3' + mode, text: 'go', images: [], model: M });
    assert.equal(r.text, 'from claude');
    assert.equal(r.model, 'claude-sonnet-5-5');
    assert.match(r.fellBack, mode === 'error' ? /529 overloaded/ : /exited 3/);
  }
});

test('a pi that never gets ready fails the call (its caller falls back)', async () => {
  const { piCall } = await import('./pi.mjs');
  process.env.FAKE_PI = 'mute';
  await assert.rejects(piCall({ system: 'S6', text: 'go', images: [], model: M, startMs: 200 }), /did not start within/);
});

test('a pi call that gives no text in time falls back too', async () => {
  process.env.FAKE_PI = 'ok';
  const { piCall } = await import('./pi.mjs');
  process.env.FAKE_PI = 'slow';
  await assert.rejects(piCall({ system: 'S4', text: 'go', images: [], model: M, timeoutMs: 100, firstTextMs: 10 }), /gave no text within|timed out/);
});

test('a text delta is read in pi\'s key order and in any other', async () => {
  const { deltaOf } = await import('./pi.mjs');
  assert.equal(deltaOf('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"a\\"b","partial":{"content":[]}}}'), 'a"b');
  assert.equal(deltaOf('{"assistantMessageEvent":{"delta":"xy","type":"text_delta"},"type":"message_update"}'), 'xy');
  assert.equal(deltaOf('{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}'), null);
  assert.equal(deltaOf('{"type":"agent_end","messages":[]}'), null);
});

test('a call whose signal is already aborted does not start', async () => {
  const ac = new AbortController(); ac.abort();
  const r = await oneShot({ system: 'S5', text: 'go', images: [], model: M, signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(r.text, '');
});

test('a claude that dies before reading its prompt fails the call, not the process', async () => {
  const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const bin = mkdtempSync(join(tmpdir(), 'kritzel-dies-'));
  symlinkSync(join(import.meta.dirname, 'test-bin', 'claude-dies'), join(bin, 'claude'));
  const path = process.env.PATH;
  process.env.PATH = bin + ':' + path;
  try {
    await assert.rejects(oneShot({ system: 'S', text: 'x'.repeat(4_000_000), images: [], model: 'claude-sonnet-5-5', provider: 'claude' }, 1), /without a result/);
  } finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
});

test('a pi model that does not take images is not asked about one: the call goes to the Claude fallback', async () => {
  process.env.FAKE_PI = 'ok';
  const r = await oneShot({ system: 'S7', text: 'what is drawn?', images: [img], model: 'fake/blind' });
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.match(r.fellBack, /does not take images/);
  const ok = await oneShot({ system: 'S7', text: 'hi', images: [], model: 'fake/blind' });   // text only: fine
  assert.match(ok.text, /Hello/);
});
