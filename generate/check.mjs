// Checks a generated things/*.js module before it may reach the viewer.
// They catch code that is broken or misbehaves, not code that looks wrong.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { track } from './children.mjs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER = resolve(HERE, '..', 'viewer');
const TIMEOUT_MS = 10_000;

// Everything a thing needs comes in through ctx. This list catches a model's mistakes (reaching
// for the page, the network, eval, Node). It is not a security boundary: names built from strings
// get through. The host is protected by the sandbox below; the browser by what the viewer allows.
const FORBIDDEN = [
  [/^\s*import\b|\bimport\s*\(/m, 'imports (everything comes from ctx)'],
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator|sendBeacon)\b/, 'network access'],
  [/\b(document|window|globalThis|location|localStorage|sessionStorage|indexedDB)\b/, 'page / browser globals'],
  [/\beval\b|\bFunction\s*\(|new\s+Function\b|setTimeout\s*\(\s*['"`]/, 'code evaluation'],
  [/\b(Worker|importScripts|postMessage)\b/, 'workers / messaging'],
  [/\b(TextureLoader|FileLoader|ImageLoader|GLTFLoader|ObjectLoader)\b/, 'loading files'],
  [/\b(process|require|getBuiltinModule|Deno|Bun)\b/, 'Node / runtime access'],
];

// comments and '…' / "…" strings are words, not code ("a door and one window" is fine).
// Template literals stay: their ${…} parts are code.
const stripWords = code => code
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/\/\/[^\n]*/g, ' ');

export function staticCheck(code) {
  const problems = [], bare = stripWords(code);
  for (const [re, what] of FORBIDDEN) if (re.test(bare)) problems.push(`not allowed: ${what} (${bare.match(re)[0].trim()})`);
  if (!/export\s+const\s+meta\s*=/.test(code)) problems.push('missing `export const meta = { name, drawing }`');
  if (!/export\s+(async\s+)?function\s+build\s*\(/.test(code)) problems.push('missing `export function build(ctx)`');
  if (code.length > 60_000) problems.push(`module too large (${code.length} chars)`);
  return problems;
}

// Runs check-run.mjs on the code in a sandboxed child: its own empty network namespace (no
// network at all), node --permission (reads only what it needs, no writes, no child processes,
// no workers, no addons), killed after TIMEOUT_MS (an endless loop is a failed check).
function runSandboxed(mode, code, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-check-'));
  const file = join(dir, 'thing.mjs');
  writeFileSync(file, code);
  const reads = [join(HERE, 'check-run.mjs'), join(HERE, 'node_modules', 'three'), join(HERE, 'package.json'), join(VIEWER, 'characters.js'), join(VIEWER, 'dialogues.js'),
    join(VIEWER, 'sim.js'), join(VIEWER, 'sound.js'), join(VIEWER, 'i18n.js'), join(VIEWER, 'portable.js'), join(VIEWER, 'book.js'), join(HERE, 'node_modules', 'rot-js'), dir];   // the sim and what it imports
  const args = ['--net', process.execPath, '--permission', ...reads.map(p => '--allow-fs-read=' + p), join(HERE, 'check-run.mjs'), mode, file, ...extra];
  return new Promise(ok => {
    const p = track(spawn('unshare', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir }));
    let out = '', err = '', timedOut = false;
    p.stdout.on('data', d => { if (out.length < 1e6) out += d; });
    p.stderr.on('data', d => { if (err.length < 1e5) err += d; });
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT_MS);
    p.on('close', () => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      if (timedOut) return ok({ error: `did not finish within ${TIMEOUT_MS / 1000}s (an endless loop?)` });
      const line = out.trim().split('\n').at(-1);
      try { ok(JSON.parse(line)); } catch { ok({ error: 'crashed: ' + (err.trim().split('\n').slice(-3).join(' ') || out.slice(-300)) }); }
    });
  });
}

// Runs build(ctx) for real (sandboxed) and checks what it produced.
// takenIds: actor ids other things already use. Returns { problems, info }.
export async function buildCheck(code, { takenIds = [] } = {}) {
  const r = await runSandboxed('build', code, [JSON.stringify(takenIds)]);
  if (r.error) return { problems: [`running it: ${r.error}`], info: {} };
  return { problems: r.problems || ['no result'], info: r.info || {} };
}

// The module's meta, read by running its top level (sandboxed). null if it does not load.
export async function metaOf(code) {
  const r = await runSandboxed('meta', code);
  return r.meta || null;
}
