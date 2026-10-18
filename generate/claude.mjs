// One headless model call: `claude -p` on this host's existing Claude Code login, or (a model id with a provider
// prefix, e.g. KRITZEL_MODEL=deepseek/deepseek-flash) a warm pi process, see pi.mjs.
// One shot, no agent loop: the image goes inline (stream-json input), all tools are off and
// the default system prompt is replaced. (--bare would be shorter but ignores the OAuth login.)
// A camera frame is input from strangers; with no tools the reply is just text we check.
import { spawn } from 'node:child_process';
import { track } from './children.mjs';
import { tmpdir } from 'node:os';
import { isPiModel, piCall } from './pi.mjs';

export const MODEL = process.env.KRITZEL_MODEL || 'claude-sonnet-5-5';
// KRITZEL_EFFORT is for measuring; an unknown value falls back to low instead of failing every call
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT = EFFORTS.includes(process.env.KRITZEL_EFFORT) ? process.env.KRITZEL_EFFORT : 'low';
export const FALLBACK_MODEL = process.env.KRITZEL_FALLBACK_MODEL || 'claude-opus-5-5';
// a model through pi ("deepseek/deepseek-flash") that fails before its first text: this Claude model takes the call
export const PI_FALLBACK = process.env.KRITZEL_PI_FALLBACK || 'claude-sonnet-5-5';

// images: JPEG Buffers, in order. Returns { text, cost, seconds, model }.
// onText(textSoFar), if given, is called as the reply streams in (to narrate what is being built).
// signal (an AbortSignal) stops the call early: it then resolves with the text so far and aborted: true.
// Claude Code updates itself in place: for a few seconds the claude binary is missing (spawn ENOENT).
// Wait and try again, so a self-update never costs a drawing.
// A model id with a provider prefix goes through pi (pi.mjs); if that fails before any text came, the same call
// goes to PI_FALLBACK, so an outage or a refused image costs a few seconds, not the drawing. Once text has
// streamed (and maybe been acted on), a failure is the caller's, as with claude.
let fellBackOnce = false;
export async function oneShot(opts, tries = 3) {
  opts = { ...opts, model: opts.model || MODEL };
  if (isPiModel(opts.model)) {
    try { return await piCall(opts); }
    catch (e) {
      if (e.sofar || opts.signal?.aborted) throw e;
      // said once per run: every call falling back would be slower than plain Claude, and silent
      const to = opts.fallback || PI_FALLBACK;          // a caller may name its own (the dialogue pool: Haiku)
      if (!fellBackOnce) { fellBackOnce = true; console.error(`${opts.model} failed, ${to} takes the call (said once per run): ${e.message.slice(0, 200)}`); }
      const r = await oneShot({ ...opts, model: to, fallback: null }, tries);
      return { ...r, fellBack: e.message.slice(0, 200) };
    }
  }
  for (let i = 1; ; i++) {
    try { return await callOnce(opts); }
    catch (e) {
      if (e.code !== 'ENOENT' || i >= tries) throw e;
      await new Promise(ok => setTimeout(ok, 5000));
    }
  }
}

function callOnce({ system, text, images, model = MODEL, effort = EFFORT, timeoutMs = 3 * 60_000, onText = null, signal = null }) {
  const msg = { type: 'user', message: { role: 'user', content: [
    ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: i.toString('base64') } })),
    { type: 'text', text },
  ] } };
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', model, '--effort', effort, '--tools', '', '--setting-sources', '', '--strict-mcp-config',
    '--no-session-persistence', '--system-prompt', system, ...(onText ? ['--include-partial-messages'] : [])];
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const p = track(spawn('claude', args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }));   // outside any repo
    let out = '', err = '', seen = 0, sofar = '';
    p.stdout.on('data', d => {
      out += d;
      if (!onText) return;
      const end = out.lastIndexOf('\n');
      if (end < seen) return;
      const before = sofar.length;
      for (const l of out.slice(seen, end).split('\n')) {      // whole lines only: text deltas of the reply
        if (!l.includes('text_delta')) continue;
        try { const e = JSON.parse(l).event; if (e?.delta?.type === 'text_delta') sofar += e.delta.text; } catch { /* not ours */ }
      }
      seen = end + 1;
      if (sofar.length > before) try { onText(sofar); } catch { /* narration never breaks the call */ }
    });
    p.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`claude -p (${model}) timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    let aborted = false;
    signal?.addEventListener('abort', () => { aborted = true; p.kill('SIGTERM'); }, { once: true });
    p.on('close', code => {
      clearTimeout(timer);
      if (aborted) return resolve({ text: sofar, aborted: true, cost: null, seconds: (Date.now() - t0) / 1000, model });
      const res = out.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(o => o?.type === 'result');
      if (!res) return reject(new Error(`claude -p (${model}) exited ${code} without a result: ${(err || out).slice(-400)}`));
      if (res.is_error || res.subtype !== 'success') return reject(new Error(`claude -p (${model}) failed: ${String(res.result).slice(0, 300)}`));
      resolve({ text: String(res.result || ''), cost: res.total_cost_usd, seconds: (Date.now() - t0) / 1000, model });
    });
    // claude gone before it read the prompt (crashed, killed, updating itself): its close reports the failure;
    // unhandled, the EPIPE would take the whole watcher down
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(msg) + '\n');
  });
}
