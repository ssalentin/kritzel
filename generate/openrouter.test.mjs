// The OpenRouter backend, against a local HTTP server: request shape, streaming, cost, retries, abort,
// timeout, and the provider switch. No key is printed anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.KRITZEL_PROVIDER = 'openrouter';
process.env.KRITZEL_OPENROUTER_BACKOFF_MS = '1';
process.env.OPENROUTER_API_KEY = 'test-key';
const { openrouterCall } = await import('./openrouter.mjs');
const { oneShot, providerProblem, MODEL } = await import('./claude.mjs');

async function serve(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* a malformed request is still inspected */ }
      requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      handler({ res, body: parsed, n: requests.length });
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  process.env.KRITZEL_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}/api/v1/chat/completions`;
  return {
    requests,
    close: () => new Promise(ok => { server.closeAllConnections(); server.close(ok); }),
  };
}

const json = (res, j, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(j));
};
const reply = (text, extra = {}) => ({ choices: [{ message: { content: text } }], model: 'deepseek/deepseek-v4.1-flash', ...extra });
const sse = (res, chunks, keepOpen = false) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
  if (!keepOpen) { res.write('data: [DONE]\n\n'); res.end(); }
};

test('a non-streaming call sends system, images then text, and returns text, cost and model', async () => {
  const s = await serve(({ res }) => json(res, reply('a house', { usage: { cost: 0.0123 } })));
  try {
    const r = await oneShot({ system: 'be kind', text: 'what is drawn?', images: [Buffer.from('jpeg')], model: 'deepseek/deepseek-v4.1-flash' });
    assert.equal(r.text, 'a house');
    assert.equal(r.cost, 0.0123);
    assert.equal(r.model, 'deepseek/deepseek-v4.1-flash');
    assert.equal(typeof r.seconds, 'number');
    const q = s.requests[0];
    assert.equal(q.auth, 'Bearer test-key');
    assert.equal(q.body.model, 'deepseek/deepseek-v4.1-flash');
    assert.equal(q.body.stream, false);
    assert.deepEqual(q.body.messages[0], { role: 'system', content: 'be kind' });
    assert.equal(q.body.messages.length, 2);
    const parts = q.body.messages[1].content;
    assert.equal(parts[0].type, 'image_url');
    assert.match(parts[0].image_url.url, /^data:image\/jpeg;base64,/);
    assert.deepEqual(parts[1], { type: 'text', text: 'what is drawn?' });
  } finally { await s.close(); }
});

test('a streaming call narrates the text so far and takes the cost from the final usage chunk', async () => {
  const s = await serve(({ res }) => sse(res, [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: {} }], usage: { cost: 0.002 } },
  ]));
  try {
    const seen = [];
    const r = await openrouterCall({ system: 's', text: 't', model: 'deepseek/deepseek-v4.1-flash', onText: t => seen.push(t) });
    assert.deepEqual(seen, ['Hel', 'Hello']);
    assert.equal(r.text, 'Hello');
    assert.equal(r.cost, 0.002);
    assert.equal(s.requests[0].body.stream, true);
    assert.deepEqual(s.requests[0].body.stream_options, { include_usage: true });
  } finally { await s.close(); }
});

test('a 429 before any text is retried with backoff, then succeeds', async () => {
  const s = await serve(({ res, n }) => n === 1
    ? json(res, { error: { message: 'rate limited' } }, 429)
    : json(res, reply('after the wait')));
  try {
    const r = await openrouterCall({ system: 's', text: 't', model: 'deepseek/deepseek-v4.1-flash' });
    assert.equal(r.text, 'after the wait');
    assert.equal(s.requests.length, 2);
  } finally { await s.close(); }
});

test('a 5xx is retried three times, then fails with the status', async () => {
  const s = await serve(({ res }) => json(res, { error: { message: 'down' } }, 503));
  try {
    await assert.rejects(openrouterCall({ system: 's', text: 't', model: 'deepseek/deepseek-v4.1-flash' }), /HTTP 503/);
    assert.equal(s.requests.length, 3);
  } finally { await s.close(); }
});

test('a connection lost after text has streamed is not retried', async () => {
  const s = await serve(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    setTimeout(() => res.destroy(new Error('cut')), 5);
  });
  try {
    await assert.rejects(openrouterCall({ system: 's', text: 't', model: 'deepseek/deepseek-v4.1-flash', onText: () => {} }));
    assert.equal(s.requests.length, 1);
  } finally { await s.close(); }
});

test('an aborted call resolves with the text so far', async () => {
  const s = await serve(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half a ' } }] })}\n\n`);
    // no more chunks: the caller aborts while waiting
  });
  try {
    const ac = new AbortController();
    const r = await openrouterCall({ system: 's', text: 't', model: 'deepseek/deepseek-v4.1-flash', signal: ac.signal,
      onText: t => { if (t === 'half a ') ac.abort(); } });
    assert.equal(r.aborted, true);
    assert.equal(r.text, 'half a ');
  } finally { await s.close(); }
});

test('a signal already aborted starts no request', async () => {
  const s = await serve(({ res }) => json(res, reply('should not run')));
  try {
    const ac = new AbortController(); ac.abort();
    const r = await openrouterCall({ system: 's', text: 't', model: 'deepseek/deepseek-v4.1-flash', signal: ac.signal });
    assert.deepEqual([r.aborted, r.text], [true, '']);
    assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('a slow provider times out instead of hanging the watcher', async () => {
  const s = await serve(() => { /* never answer */ });
  try {
    await assert.rejects(openrouterCall({ system: 's', text: 't', model: 'deepseek/deepseek-v4.1-flash', timeoutMs: 60 }), /timed out/);
  } finally { await s.close(); }
});

test('a missing key fails loudly, at the call and at startup', async () => {
  const key = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.match(providerProblem(), /OPENROUTER_API_KEY/);
    await assert.rejects(openrouterCall({ system: 's', text: 't', model: 'deepseek/deepseek-v4.1-flash' }), /OPENROUTER_API_KEY/);
  } finally { process.env.OPENROUTER_API_KEY = key; }
  assert.equal(providerProblem(), null);
});

test('the default model for the OpenRouter path is DeepSeek v4.1 flash', () => {
  assert.equal(MODEL, 'deepseek/deepseek-v4.1-flash');
});

test('text requests keep their own Claude provider and model under the OpenRouter provider', async () => {
  const { TEXT_PROVIDER, TEXT_MODEL } = await import('./generate.mjs');
  assert.equal(TEXT_PROVIDER, 'claude');
  assert.equal(TEXT_MODEL, 'claude-sonnet-5-5');
});
