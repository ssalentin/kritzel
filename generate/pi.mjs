// Calls to models other than Claude (DeepSeek v4 flash) through pi (https://github.com/badlogic/pi-mono),
// which holds the provider login (~/.pi/agent/auth.json; this code never reads it). Each pi runs in RPC mode
// and stays warm between calls: a cold start costs ~1.3 s, a warm call answers its first text after ~1 s.
// No tools, no extensions, skills or context files: like `claude -p` here, the reply is just text we check.
//
// A model id with a provider prefix ("deepseek/deepseek-v4-flash") goes through pi; see oneShot in claude.mjs.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { track } from './children.mjs';

export const isPiModel = model => typeof model === 'string' && model.includes('/');
const KEEP = 6;                                    // idle processes kept per (model, system prompt): ~140 MB each
const idle = new Map();                            // key → [worker]

function startWorker(model, system) {
  const p = track(spawn('pi', ['--mode', 'rpc', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files',
    '--no-prompt-templates', '--no-themes', '--thinking', 'off', '--model', model, '--system-prompt', system],
  { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }));    // outside any repo
  const w = { p, model, system, onLine: null, dead: false, used: false, err: '' };
  // ready once it answers a first command: a cold start takes ~1.3 s, several at once on a busy host 5 s and more,
  // and that must not count against the first-text timeout
  w.ready = new Promise(ok => { w.onLine = line => { if (line.startsWith('{"') && line.includes('"id":"ready"')) { w.onLine = null; ok(); } }; });
  p.stdin.write(JSON.stringify({ id: 'ready', type: 'get_state' }) + '\n');
  let buf = '';
  p.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {     // JSONL split on \n only (U+2028 is valid inside JSON strings)
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      try { w.onLine?.(line); } catch { /* a broken handler must not stop the reader */ }
    }
  });
  p.stderr.on('data', d => { w.err = (w.err + d).slice(-2000); });
  p.on('error', e => { w.dead = true; w.onExit?.(e); });
  p.on('close', code => { w.dead = true; drop(w); w.onExit?.(new Error(`pi exited ${code}: ${w.err.slice(-300)}`)); });
  p.stdin.on('error', () => { /* the process is gone: its close says so */ });
  return w;
}
// an idle process must not keep node running (a one-frame run exits when done); a busy one does
function hold(w, on) { for (const x of [w.p, w.p.stdin, w.p.stdout, w.p.stderr]) on ? x.ref?.() : x.unref?.(); }
const keyOf = (model, system) => model + '\n' + system;
function drop(w) { const l = idle.get(keyOf(w.model, w.system)); if (l?.includes(w)) l.splice(l.indexOf(w), 1); }
function take(model, system) {
  const l = idle.get(keyOf(model, system)) || [];
  while (l.length) { const w = l.pop(); if (!w.dead) return w; }
  return startWorker(model, system);
}
function giveBack(w) {
  if (w.dead) return;
  const k = keyOf(w.model, w.system), l = idle.get(k) || [];
  if (l.length >= KEEP) { w.p.kill('SIGTERM'); return; }
  w.onLine = null; w.onExit = null;
  hold(w, false);
  l.push(w); idle.set(k, l);
}

// start n warm processes ahead of the first frame (the watcher does this at start)
export function prewarm(model, system, n) {
  const l = idle.get(keyOf(model, system)) || [];
  while (l.length < n) { const w = startWorker(model, system); hold(w, false); l.push(w); }
  idle.set(keyOf(model, system), l);
}

// the text of one text_delta event: every update repeats the full reply so far ("partial"), so a long reply
// would cost a JSON.parse of megabytes. Fast path for pi's key order; any other message_update is parsed whole
// (if a pi update reorders the keys, the stream gets slower, not lost)
export function deltaOf(line) {
  if (line.startsWith('{"type":"message_update","assistantMessageEvent":{"type":"text_delta"')) {
    const a = line.indexOf('"delta":'), b = line.indexOf(',"partial":', a);
    if (a >= 0 && b >= 0) try { return JSON.parse(line.slice(a + 8, b)); } catch { /* parse it whole */ }
  } else if (!line.includes('"message_update"')) return null;
  try { const e = JSON.parse(line); return e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta' ? String(e.assistantMessageEvent.delta ?? '') : null; } catch { return null; }
}

// Same shape as oneShot: { text, cost, seconds, model } or, when signal aborts it, { text: sofar, aborted: true }.
// firstTextMs: no text by then → the call fails (its caller can still try another model), so a stuck
// provider costs seconds, not minutes.
// startMs: a process not ready by then (cold, on a busy host) fails the call (killed).
export async function piCall({ system, text, images = [], model, timeoutMs = 3 * 60_000, firstTextMs = 20_000, startMs = 30_000, onText = null, signal = null }) {
  if (signal?.aborted) return { text: '', aborted: true, cost: null, seconds: 0, model };
  const w = take(model, system), t0 = Date.now();
  hold(w, true);
  let startTimer;
  const started = await Promise.race([w.ready.then(() => true), new Promise(ok => { startTimer = setTimeout(() => ok(false), startMs); w.onExit = () => ok(false); })]);
  clearTimeout(startTimer);
  if (!started) { w.p.kill('SIGTERM'); throw Object.assign(new Error(`pi (${model}) did not start within ${startMs / 1000}s: ${w.err.slice(-200)}`), { sofar: '' }); }
  if (signal?.aborted) { giveBack(w); return { text: '', aborted: true, cost: null, seconds: (Date.now() - t0) / 1000, model }; }
  return new Promise((resolve, reject) => {
    let sofar = '', settled = false, aborted = false;
    const done = (fn, v, reuse) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(firstTimer);
      if (reuse) giveBack(w); else w.p.kill('SIGTERM');
      fn(v);
    };
    const fail = msg => done(reject, Object.assign(new Error(`pi (${model}) ${msg}`), { sofar }), false);
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    const firstTimer = setTimeout(() => { if (!sofar) fail(`gave no text within ${firstTextMs / 1000}s`); }, firstTextMs);
    w.onExit = e => fail(e.message);
    signal?.addEventListener('abort', () => { aborted = true; w.p.stdin.write(JSON.stringify({ type: 'abort' }) + '\n'); }, { once: true });
    const onReply = line => {
      const d = deltaOf(line);
      if (d != null) {
        sofar += d;
        if (onText) try { onText(sofar); } catch { /* narration never breaks the call */ }
        return;
      }
      if (line.startsWith('{"type":"response"') && line.includes('"success":false')) return fail(`refused the prompt: ${line.slice(0, 300)}`);
      if (!line.startsWith('{"type":"agent_end"')) return;
      let m = null;
      try { m = JSON.parse(line).messages?.filter(x => x.role === 'assistant').at(-1); } catch { /* checked below */ }
      const seconds = (Date.now() - t0) / 1000, cost = m?.usage?.cost?.total ?? null;
      if (aborted) return done(resolve, { text: sofar, aborted: true, cost, seconds, model }, true);
      if (!m || m.stopReason === 'error' || m.stopReason === 'aborted') return fail(`failed: ${String(m?.errorMessage || 'no reply').slice(0, 300)}`);
      const full = (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      done(resolve, { text: full || sofar, cost, seconds, model, ...(m.stopReason === 'length' && { truncated: true }) }, true);
    };
    const prompt = () => {
      w.onLine = onReply;
      w.p.stdin.write(JSON.stringify({ type: 'prompt', message: text,
        images: images.map(i => ({ type: 'image', data: i.toString('base64'), mimeType: 'image/jpeg' })) }) + '\n');
    };
    if (!w.used) { w.used = true; return prompt(); }
    // a fresh conversation every call: the prompt goes once the old one is cleared
    w.onLine = line => { if (line.startsWith('{"type":"response"') && line.includes('"command":"new_session"')) prompt(); };
    w.p.stdin.write(JSON.stringify({ type: 'new_session' }) + '\n');
  });
}
