#!/usr/bin/env node
// One recognised drawing → one 32x32 claude-pxl sprite (source + PNG).
//
//   node scripts/thing_sprite.mjs --name Drache --drawing "a green dragon..." \
//     --kind actor --move fly --file drache.js --out viewer/pixel/sprites
//
// The text model writes a 32x32 grid from the recognised description. We validate it strictly and
// ask once more with the exact parse error; a second bad grid is a visible failure (no files).
// claude-pxl (pinned) turns the source into a hard-edged PNG. The model is the text model, never
// the frame model.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneShot } from '../generate/claude.mjs';
import { DRAGON, TOWER, TREE } from './sprite-examples.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PXL_COMMIT = '21fee41f7ecce00bc868d7567f24ffd0f3acc8fa';
export const PXL_DIR = process.env.PXL_DIR || join(ROOT, '.kritzel', 'claude-pxl');
export const TEXT_PROVIDER = process.env.KRITZEL_TEXT_PROVIDER || 'claude';
export const TEXT_MODEL = process.env.KRITZEL_TEXT_MODEL || 'claude-sonnet-5-5';
const currentMode = () => {
  try {
    const p = process.env.KRITZEL_WORLD_MODE || join(ROOT, 'world-mode.json');
    return JSON.parse(readFileSync(p, 'utf8')).render === 'pixel' ? 'pixel' : '3d';
  } catch { return '3d'; }
};

// The same fixed palette as the pixel-mode viewer. Dots are transparent; the model draws its own
// selective outline with k (no automatic outline option: that would add a 1px frame → 34x34).
export const PALETTE = {
  k: '#1b1630', w: '#fff6e0', c: '#f4e8c8', C: '#d8c49a',
  g: '#38b764', G: '#257179', l: '#a7f070', r: '#b13e53', R: '#5d275d',
  b: '#41a6f6', B: '#29366f', y: '#ffcd75', Y: '#ef7d57', o: '#ef7d57',
  n: '#94b0c2', N: '#566c86', m: '#333c57', p: '#b55088', P: '#5d275d',
  s: '#ffccaa', S: '#c98f6b', e: '#8a5a3c', E: '#5c3a2c', a: '#2ce8f5',
};
export const PAL = `pal({
  k: "#1b1630", w: "#fff6e0", c: "#f4e8c8", C: "#d8c49a",
  g: "#38b764", G: "#257179", l: "#a7f070", r: "#b13e53", R: "#5d275d",
  b: "#41a6f6", B: "#29366f", y: "#ffcd75", Y: "#ef7d57", o: "#ef7d57",
  n: "#94b0c2", N: "#566c86", m: "#333c57", p: "#b55088", P: "#5d275d",
  s: "#ffccaa", S: "#c98f6b", e: "#8a5a3c", E: "#5c3a2c", a: "#2ce8f5",
})`;
const ALLOWED = new Set(['.', ...Object.keys(PALETTE)]);
const RGB = new Set(Object.values(PALETTE).map(h => h.slice(1).toUpperCase()));

export const SYSTEM = `You are a meticulous pixel artist making one 32x32 sprite for a children's pop-up book. The drawing has already been recognised; turn its description into a readable sprite. Reply with the grid only: exactly 32 lines of exactly 32 characters, no code fences, no labels, no explanation.`;

const indentOf = s => (s.match(/^\s*/) || [''])[0].length;

export function parseGrid(text) {
  let t = String(text ?? '').trim();
  t = t.replace(/^```(?:text|txt|js|javascript)?\s*/i, '').replace(/\s*```$/i, '').trim();
  t = t.replace(/^GRID:\s*/i, '');
  let rows = t.split(/\r?\n/);
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows.at(-1).trim()) rows.pop();
  const indent = Math.min(...rows.filter(r => r.trim()).map(indentOf));
  if (Number.isFinite(indent) && indent > 0) rows = rows.map(r => r.slice(indent));
  rows = rows.map(r => r.replace(/\s+$/, ''));
  if (rows.length !== 32) throw new Error(`need exactly 32 rows, got ${rows.length}`);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== 32) throw new Error(`row ${i + 1} has ${rows[i].length} characters, need 32`);
    const bad = [...rows[i]].find(c => !ALLOWED.has(c));
    if (bad) throw new Error(`row ${i + 1} has unknown key "${bad}"; use dots or ${Object.keys(PALETTE).join('')}`);
  }
  const opaque = rows.join('').replace(/\./g, '');
  const share = opaque.length / 1024;
  if (!opaque.length) throw new Error('the grid is empty: draw a silhouette');
  if (share < 0.15) throw new Error(`only ${(share * 100).toFixed(1)}% of the box is opaque; fill at least 15%`);
  if (share > 0.90) throw new Error(`${(share * 100).toFixed(1)}% of the box is opaque; leave a transparent margin (at most 90%)`);
  if (new Set(opaque).size < 2) throw new Error('use more than one palette key: an outline plus material tones');
  return rows;
}

const example = rows => rows.join('\n');

export function spritePrompt({ name = '', drawing = '', kind = '', move = '' }) {
  return `Draw ONE 32x32 sprite for the recognised thing below.

Name: ${JSON.stringify(name || 'thing')}
Drawing: ${JSON.stringify(drawing || name || 'a small thing')}
Kind: ${kind || 'scenery'}
Move: ${move || 'none'}

Reply with exactly 32 lines of exactly 32 characters and nothing else.
Keys: . = transparent; ${Object.keys(PALETTE).join(' ')} = the fixed palette.
Palette: ${Object.entries(PALETTE).map(([k, v]) => `${k} ${v}`).join(' · ')}

Style (Final-Fantasy-like 32px monster/object):
- A strong readable silhouette that fills 15-90% of the 32x32 box, centred, feet/base at the bottom.
- The Drawing is the subject, not an archetype. If it names a support, vehicle, pose or part (a witch riding a broom, an Eiffel Tower's four legs and platforms, a girl in a wheelchair), that feature must be visible in the sprite. The examples below are style references only.
- Selective dark outline (k) only where needed; 4-6 tones per material (for example k,G,g,l for green).
- Dither or step between tones; no smooth gradients, no anti-aliasing, no text, no shadow ellipse.
- One or two signature features that identify it (horns, wings, face, windows, leaves, wheels).
- A face only for a living thing (kind actor / person / animal); scenery has no face.
- Transparent background: use dots, never a solid bounding rectangle.
- Keep every row exactly 32 characters; do not pad with spaces (use dots).

Worked examples:
Dragon (living; wings, horns, face):
${example(DRAGON)}

Tower (scenery; windows, spire):
${example(TOWER)}

Tree (scenery; canopy and trunk):
${example(TREE)}`;
}

function fixPrompt(prompt, reply, problem) {
  return `${prompt}

Your previous reply was rejected: ${problem}
Previous reply:
${String(reply).slice(0, 2500)}

Return the corrected 32x32 grid only: 32 lines of exactly 32 characters, no fences or prose.`;
}

export function spriteSource(file, base, rows) {
  return `// generated by scripts/thing_sprite.mjs from ${file}
${PAL}
sprite(${JSON.stringify(base)}, \`
${rows.join('\n')}
\`)
`;
}

export function ensurePxl(dir = PXL_DIR) {
  if (!existsSync(join(dir, 'bin', 'pxl.js'))) {
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync(process.env.KRITZEL_GIT || 'git', ['clone', '-q', 'https://github.com/crsolver/claude-pxl', dir], { stdio: 'pipe' });
  }
  const git = process.env.KRITZEL_GIT || 'git';
  let head = '';
  try { head = execFileSync(git, ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (e) {
    throw new Error(`claude-pxl checkout is missing: ${e.message.slice(0, 120)}`);
  }
  if (head !== PXL_COMMIT) {
    execFileSync(git, ['-C', dir, 'fetch', '-q', 'origin'], { stdio: 'pipe' });
    execFileSync(git, ['-C', dir, 'checkout', '-q', PXL_COMMIT], { stdio: 'pipe' });
  }
  if (!existsSync(join(dir, 'bin', 'pxl.js'))) throw new Error(`claude-pxl CLI not found at ${dir}`);
  return dir;
}

// Only palette colours may reach the viewer. The PNG has a transparent background; every other
// pixel must be one of the fixed palette colours.
export function validatePng(png) {
  const dims = execFileSync('identify', ['-format', '%w %h', png], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  if (dims[0] !== 32 || dims[1] !== 32) throw new Error(`sprite PNG is ${dims[0]}x${dims[1]}, need 32x32`);
  const hist = execFileSync('convert', [png, '-format', '%c', 'histogram:info:'], { encoding: 'utf8' });
  for (const m of hist.matchAll(/#([0-9A-Fa-f]{8})/g)) {
    const hex = m[1].toUpperCase();
    if (hex.slice(6) === '00') continue;                 // transparent
    if (!RGB.has(hex.slice(0, 6))) throw new Error(`sprite uses a colour outside the palette: #${hex}`);
  }
  return dims;
}

export function buildPng({ source, base, outDir, pxlDir = PXL_DIR, requireMode = null }) {
  const started = Date.now();
  const dir = ensurePxl(pxlDir);
  const stage = mkdtempSync(join(tmpdir(), 'kritzel-sprite-'));
  try {
    const art = join(stage, base + '.px.js');
    writeFileSync(art, source);
    const out = join(stage, 'out');
    execFileSync(process.execPath, [join(dir, 'bin', 'pxl.js'), 'build', art, '--out', out, '--only', base, '--no-preview'],
      { timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const png = join(out, 'sprites', base + '.png');
    if (!existsSync(png)) throw new Error(`claude-pxl wrote no ${base}.png`);
    validatePng(png);
    if (requireMode && currentMode() !== requireMode)
      throw new Error(`render mode changed to ${currentMode()}: not publishing a ${requireMode} sprite`);
    mkdirSync(outDir, { recursive: true });
    const finalSrc = join(outDir, base + '.px.js');
    const finalPng = join(outDir, base + '.png');
    const tmpSrc = join(outDir, `.${base}.px.js.tmp-${process.pid}`);
    const tmpPng = join(outDir, `.${base}.png.tmp-${process.pid}`);
    writeFileSync(tmpSrc, source);
    copyFileSync(png, tmpPng);
    renameSync(tmpPng, finalPng);                       // the viewer only needs the PNG: publish it first
    try { renameSync(tmpSrc, finalSrc); } catch (e) {
      throw new Error(`could not publish the sprite source: ${e.message}`);
    }
    return { source: finalSrc, png: finalPng, bytes: statSync(finalPng).size, ms: Date.now() - started };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function defaultAsk(prompt, system = SYSTEM) {
  const r = await oneShot({ system, text: prompt, images: [], provider: TEXT_PROVIDER, model: TEXT_MODEL, timeoutMs: 90_000 });
  return { text: r.text, model: r.model, cost: r.cost, seconds: r.seconds, provider: TEXT_PROVIDER };
}

function writeReport(reportDir, base, report) {
  mkdirSync(reportDir, { recursive: true });
  const path = join(reportDir, base + '.sprite.json');
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(report, null, 1));
  renameSync(tmp, path);
  return path;
}

export async function makeSprite({ name = '', drawing = '', kind = '', move = '', file = '', outDir, reportDir,
  ask = defaultAsk, build = buildPng, pxlDir = PXL_DIR, requireMode = null } = {}) {
  const base = basename(String(file || name || 'thing')).replace(/\.js$/, '');
  outDir = outDir || join(ROOT, 'viewer', 'pixel', 'sprites');
  reportDir = reportDir || join(ROOT, 'frames', 'generated');
  const started = Date.now();
  const prompt = spritePrompt({ name, drawing, kind, move });
  const report = { file: base + '.js', name, drawing, kind, move, provider: TEXT_PROVIDER, model: TEXT_MODEL,
    prompt, calls: [], reply: '', fixed: false, error: null };
  let rows = null, problem = null, reply = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ask(attempt ? fixPrompt(prompt, reply, problem) : prompt);
    report.calls.push({ model: r.model || TEXT_MODEL, provider: r.provider || TEXT_PROVIDER,
      seconds: r.seconds ?? null, cost: r.cost ?? null, fix: attempt > 0 });
    reply = String(r.text ?? '');
    report.reply = reply;
    try {
      rows = parseGrid(reply);
      problem = null;
      report.fixed = attempt > 0;
      break;
    } catch (e) {
      problem = e.message;
    }
  }
  report.seconds = +((Date.now() - started) / 1000).toFixed(2);
  if (problem || !rows) {
    report.error = `sprite grid rejected after one fix: ${problem}`;
    report.report = writeReport(reportDir, base, report);
    throw new Error(report.error);
  }
  try {
    const built = await build({ source: spriteSource(base + '.js', base, rows), base, outDir, pxlDir, requireMode });
    report.rows = rows;
    report.source = built.source;
    report.png = built.png;
    report.bytes = built.bytes;
    report.buildMs = built.ms;
    report.report = writeReport(reportDir, base, report);
    return report;
  } catch (e) {
    report.error = `sprite build failed: ${e.message}`;
    report.report = writeReport(reportDir, base, report);
    throw new Error(report.error);
  }
}

function parseArgs(argv) {
  const a = { out: null, report: null, pxl: null, ensure: false, promptOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--ensure') a.ensure = true;
    else if (k === '--prompt-only') a.promptOnly = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
    else throw new Error(`unexpected argument ${k}`);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  try {
    if (a.ensure) ensurePxl(a.pxl || PXL_DIR);
    const name = a.name || '', drawing = a.drawing || name, kind = a.kind || '', move = a.move || '';
    const file = a.file || (name.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'ding') + '.js';
    const base = basename(file).replace(/\.js$/, '');
    if (a.promptOnly) { console.log(spritePrompt({ name, drawing, kind, move })); return 0; }
    if (!a.ensure && (a.name === undefined && a.drawing === undefined && a.file === undefined)) {
      throw new Error('name/drawing/file is required (or use --ensure)');
    }
    const outDir = a.out ? resolve(a.out) : join(ROOT, 'viewer', 'pixel', 'sprites');
    const reportDir = a.report ? dirname(resolve(a.report)) : join(ROOT, 'frames', 'generated');
    const report = await makeSprite({ name, drawing, kind, move, file, outDir, reportDir, pxlDir: a.pxl || PXL_DIR,
      requireMode: a['require-mode'] || null });
    console.log(JSON.stringify({ ok: true, file: base + '.js', source: report.source, png: report.png,
      bytes: report.bytes, seconds: report.seconds, buildMs: report.buildMs,
      model: report.calls.at(-1)?.model, cost: report.calls.reduce((n, c) => n + (Number(c.cost) || 0), 0),
      fixed: report.fixed, report: report.report }));
    return 0;
  } catch (e) {
    console.error(`sprite: ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message }));
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
