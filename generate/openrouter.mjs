// One headless model call through OpenRouter (POST /api/v1/chat/completions). Same result contract as the
// claude and pi backends in claude.mjs: { text, cost, seconds, model }, or { text: sofar, aborted: true }.
// The key comes from OPENROUTER_API_KEY at call time and is never written or logged.
//
// A camera frame is input from strangers; like the other backends, the reply is just text that check.mjs
// validates before it can become a things/*.js module.
const DEFAULT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ATTEMPTS = 3;
// tests make the wait tiny; the product waits a second, then two
const backoffMs = () => {
  const n = Number(process.env.KRITZEL_OPENROUTER_BACKOFF_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
};
const urlOf = () => process.env.KRITZEL_OPENROUTER_URL || DEFAULT_URL;

export function hasKey() { return !!process.env.OPENROUTER_API_KEY; }

const contentOf = j => {
  const c = j?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => typeof p === 'string' ? p : String(p?.text ?? '')).join('');
  return '';
};
const costOf = j => {
  const c = Number(j?.usage?.cost);
  return Number.isFinite(c) ? c : null;
};
// a streamed delta may be a string or a list of parts (OpenRouter passes through what the provider sends)
const deltaOf = j => {
  const d = j?.choices?.[0]?.delta?.content;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(p => typeof p === 'string' ? p : String(p?.text ?? '')).join('');
  return '';
};

const wait = (ms, signal) => new Promise(ok => {
  const t = setTimeout(ok, Math.max(0, ms));
  signal?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
});

function retryAfterMs(e) {
  const s = Number(e?.retryAfter);
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

// one HTTP attempt. state.sofar carries the text streamed so far into the caller, so a failure after text
// can never be retried (the caller may already have acted on it).
async function attempt({ key, body, model, timeoutMs, onText, signal, state }) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(1, timeoutMs));
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const t0 = Date.now();
  try {
    let res;
    try {
      res = await fetch(urlOf(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (!timedOut && !signal?.aborted) e.network = true;
      throw e;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const e = new Error(`openrouter (${model}) HTTP ${res.status}: ${detail.slice(0, 300)}`);
      e.status = res.status;
      e.retryAfter = res.headers.get('retry-after');
      throw e;
    }
    const type = res.headers.get('content-type') || '';
    // a server (or a test double) may answer a streaming request with one JSON body
    if (!onText || !type.includes('text/event-stream')) {
      const j = await res.json();
      const text = contentOf(j);
      state.sofar = text;
      if (onText && text) onText(text);
      return { text, cost: costOf(j), seconds: (Date.now() - t0) / 1000, model: j.model || model };
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', usage = null, actual = model, finished = false;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { finished = true; continue; }
        let j;
        try { j = JSON.parse(data); } catch { continue; }   // an SSE comment or a keep-alive
        if (j?.error) throw new Error(`openrouter (${model}) stream error: ${String(j.error.message || JSON.stringify(j.error)).slice(0, 300)}`);
        if (j?.model) actual = j.model;
        const d = deltaOf(j);
        if (d) {
          state.sofar += d;
          if (onText) try { onText(state.sofar); } catch { /* narration never breaks the call */ }
        }
        if (j?.usage) usage = j.usage;
      }
    }
    // A clean HTTP close is not a complete reply: without [DONE] it may be a truncated module. Fail it
    // rather than returning partial text that looks like a finished section.
    if (!finished) throw Object.assign(new Error(`openrouter (${model}) closed the stream without [DONE]`), { network: true });
    return { text: state.sofar, cost: usage ? (Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null) : null,
      seconds: (Date.now() - t0) / 1000, model: actual };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function openrouterCall({ system = '', text, images = [], model, effort = null, timeoutMs = 3 * 60_000, onText = null, signal = null }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set: export the OpenRouter key (KRITZEL_PROVIDER=openrouter)');
  if (signal?.aborted) return { text: '', aborted: true, cost: null, seconds: 0, model };
  const content = [
    ...images.map(i => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${i.toString('base64')}` } })),
    { type: 'text', text },
  ];
  const body = {
    model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }],
    stream: !!onText,
    // OpenRouter extensions: the cost of this call comes back in usage (never in the prompt or logs)
    usage: { include: true },
    ...(onText ? { stream_options: { include_usage: true } } : {}),
  };
  const state = { sofar: '' }, t0 = Date.now(), deadline = t0 + timeoutMs;
  let last = null;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      return await attempt({ key, body, model, timeoutMs: Math.max(1, deadline - Date.now()), onText, signal, state });
    } catch (e) {
      last = e;
      if (signal?.aborted) return { text: state.sofar, aborted: true, cost: null, seconds: (Date.now() - t0) / 1000, model };
      // once text has streamed the caller may have acted on it: never send the call again
      const retryable = e.status === 429 || (e.status >= 500 && e.status <= 599) || e.network;
      if (state.sofar || !retryable || i === ATTEMPTS || Date.now() >= deadline) break;
      await wait(retryAfterMs(e) ?? backoffMs() * 2 ** (i - 1), signal);
      if (signal?.aborted) return { text: state.sofar, aborted: true, cost: null, seconds: (Date.now() - t0) / 1000, model };
    }
  }
  if (signal?.aborted) return { text: state.sofar, aborted: true, cost: null, seconds: (Date.now() - t0) / 1000, model };
  if (last?.name === 'AbortError' || last?.viaTimeout) throw new Error(`openrouter (${model}) timed out after ${timeoutMs / 1000}s`);
  throw last;
}
