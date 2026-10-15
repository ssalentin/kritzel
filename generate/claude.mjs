// One headless Claude Code call (`claude -p`) on this host's existing Claude Code login.
// One shot, no agent loop: the image goes inline (stream-json input), all tools are off and
// the default system prompt is replaced. (--bare would be shorter but ignores the OAuth login.)
// A camera frame is input from strangers; with no tools the reply is just text we check.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export const MODEL = process.env.KRITZEL_MODEL || 'claude-sonnet-5-5';
export const FALLBACK_MODEL = process.env.KRITZEL_FALLBACK_MODEL || 'claude-opus-5-5';

// images: JPEG Buffers, in order. Returns { text, cost, seconds, model }.
export function oneShot({ system, text, images, model = MODEL, effort = 'low', timeoutMs = 3 * 60_000 }) {
  const msg = { type: 'user', message: { role: 'user', content: [
    ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: i.toString('base64') } })),
    { type: 'text', text },
  ] } };
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', model, '--effort', effort, '--tools', '', '--setting-sources', '', '--strict-mcp-config',
    '--no-session-persistence', '--system-prompt', system];
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });   // outside any repo
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`claude -p (${model}) timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      const res = out.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(o => o?.type === 'result');
      if (!res) return reject(new Error(`claude -p (${model}) exited ${code} without a result: ${(err || out).slice(-400)}`));
      if (res.is_error || res.subtype !== 'success') return reject(new Error(`claude -p (${model}) failed: ${String(res.result).slice(0, 300)}`));
      resolve({ text: String(res.result || ''), cost: res.total_cost_usd, seconds: (Date.now() - t0) / 1000, model });
    });
    p.stdin.end(JSON.stringify(msg) + '\n');
  });
}
