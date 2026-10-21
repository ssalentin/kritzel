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
import { MOVERS, moverFor } from '../viewer/pixel/motion.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PXL_COMMIT = '21fee41f7ecce00bc868d7567f24ffd0f3acc8fa';
export const PXL_DIR = process.env.PXL_DIR || join(ROOT, '.kritzel', 'claude-pxl');
export const TEXT_PROVIDER = process.env.KRITZEL_TEXT_PROVIDER || 'claude';
export const TEXT_MODEL = process.env.KRITZEL_TEXT_MODEL || 'claude-sonnet-5-5';
const REFERENCE = process.env.KRITZEL_SPRITE_REFERENCE || '';
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

export const MOVES = MOVERS;
const FRAMES = { walk: 4, fly: 3, swim: 3, hop: 2, climb: 4, roll: 4 };
const FPS = { walk: 10, fly: 8, swim: 6, hop: 6, climb: 6, roll: 8 };

// Missing move is inferred here once, so the JSON and the strip always carry a real animation.
export function inferMove(name = '', drawing = '', kind = '') {
  if (kind !== 'actor') return '';
  return moverFor({ name, drawing });
}
export function moveFor(name, drawing, kind, move) {
  if (kind !== 'actor') return '';
  const m = String(move || '').toLowerCase();
  if (m === 'crawl') return 'walk';                 // the pixel viewer has no crawl mover
  return MOVERS.includes(m) ? m : moverFor({ name, drawing, move });
}
export const framesFor = (kind, move) => kind === 'actor' ? (FRAMES[move] || 4) : 1;
export const fpsFor = (kind, move) => kind === 'actor' ? (FPS[move] || 6) : 1;
export const heightFor = (name = '', drawing = '', kind = '') =>
  kind === 'actor' && /giraffe|giraffe|reiter|rider|centaur|zentaur/i.test(`${name} ${drawing}`) ? 48 : 32;

export const SYSTEM = `You are a meticulous pixel artist making whole sprite frames for a children's pop-up book. The drawing has already been recognised; turn its description into readable Final-Fantasy-like pixel art. Reply only with FRAME sections and 32-character grid rows; no code fences, labels or explanation.`;

const indentOf = s => (s.match(/^\s*/) || [''])[0].length;

export function parseGrid(text, height = 32) {
  let t = String(text ?? '').trim();
  t = t.replace(/^```(?:text|txt|js|javascript)?\s*/i, '').replace(/\s*```$/i, '').trim();
  t = t.replace(/^GRID:\s*/i, '');
  let rows = t.split(/\r?\n/);
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows.at(-1).trim()) rows.pop();
  const indent = Math.min(...rows.filter(r => r.trim()).map(indentOf));
  if (Number.isFinite(indent) && indent > 0) rows = rows.map(r => r.slice(indent));
  rows = rows.map(r => r.replace(/\s+$/, ''));
  // A transparent edge row is padding, not part of the figure; the model sometimes adds one.
  while (rows.length > height && rows[0].replace(/\./g, '') === '') rows.shift();
  while (rows.length > height && rows.at(-1).replace(/\./g, '') === '') rows.pop();
  if (rows.length !== height) throw new Error(`need exactly ${height} rows, got ${rows.length}`);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== 32) throw new Error(`row ${i + 1} has ${rows[i].length} characters, need 32`);
    const bad = [...rows[i]].find(c => !ALLOWED.has(c));
    if (bad) throw new Error(`row ${i + 1} has unknown key "${bad}"; use dots or ${Object.keys(PALETTE).join('')}`);
  }
  const opaque = rows.join('').replace(/\./g, '');
  const share = opaque.length / (32 * height);
  if (!opaque.length) throw new Error('the grid is empty: draw a silhouette');
  if (share < 0.15) throw new Error(`only ${(share * 100).toFixed(1)}% of the box is opaque; fill at least 15%`);
  if (share > 0.90) throw new Error(`${(share * 100).toFixed(1)}% of the box is opaque; leave a transparent margin (at most 90%)`);
  if (new Set(opaque).size < 2) throw new Error('use more than one palette key: an outline plus material tones');
  return rows;
}

// A strip is N complete frames, each with a FRAME n header (a bare grid is accepted for one frame).
export function parseFrames(text, { frames = 1, height = 32 } = {}) {
  let t = String(text ?? '').trim();
  t = t.replace(/^```(?:text|txt|js|javascript)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (frames === 1) {
    const one = t.match(/^FRAME\s+1\s*:?\s*\r?\n([\s\S]*)$/i);
    return [parseGrid(one ? one[1] : t, height)];
  }
  const parts = t.split(/^FRAME\s+(\d+)\s*:?\s*$/mi);
  const found = [];
  for (let i = 1; i < parts.length; i += 2) found[+parts[i] - 1] = parts[i + 1];
  if (found.length !== frames || found.some(x => x === undefined))
    throw new Error(`need FRAME 1 through FRAME ${frames}, each followed by a complete grid`);
  const rows = found.map((x, i) => {
    try { return parseGrid(x, height); } catch (e) { throw new Error(`frame ${i + 1}: ${e.message}`); }
  });
  if (new Set(rows.map(r => r.join('\n'))).size < 2)
    throw new Error('all frames are identical: redraw the pose in every frame (the body and limbs must actually change)');
  return rows;
}

const example = rows => rows.join('\n');

const POSE = {
  walk: 'FRAME 1 contact: front leg forward, back leg back, arms opposite. FRAME 2 down: body lowest, front foot planted. FRAME 3 pass: legs together under the body, body highest. FRAME 4 up: the opposite contact, the other leg forward. Redraw the whole body and both legs in every frame; alternate the arms; do not copy or translate a frame.',
  fly: 'FRAME 1 wings up, FRAME 2 wings level with the body highest, FRAME 3 wings down. Keep the body whole; redraw the wing shapes.',
  swim: 'FRAME 1 tail/body bend left, FRAME 2 body straight, FRAME 3 bend right. Redraw the whole fish/creature; the tail changes shape.',
  hop: 'FRAME 1 crouch (legs compressed, body low), FRAME 2 airborne (legs tucked or spread, body high).',
  climb: 'FRAME 1 left hand and right foot reach, FRAME 2 body pulls up, FRAME 3 right hand and left foot reach, FRAME 4 body settles. Redraw whole limbs.',
  roll: 'FRAME 1 upright mark, FRAME 2 mark rotated a quarter, FRAME 3 mark upside down, FRAME 4 mark rotated the other way. The whole round body stays whole.',
};

export function spritePrompt({ name = '', drawing = '', kind = '', move = '', frames = 1, height = 32 } = {}) {
  const actor = kind === 'actor';
  const frameText = actor && frames > 1
    ? `Draw ${frames} WHOLE animation frames of the same actor for a horizontal strip.

Name: ${JSON.stringify(name || 'thing')}
Drawing: ${JSON.stringify(drawing || name || 'a living thing')}
Kind: ${kind}
Move: ${move}

Each frame is a complete ${32}x${height} sprite: exactly ${height} lines of exactly 32 characters, each with its own FRAME n header. The PNG strip will show the frames side by side; the viewer never slices a figure.

Pose cycle:
${POSE[move] || POSE.walk}

Every frame must be redrawn as a whole figure, not a copied or translated frame. The frames must differ. Keep the same character, palette, proportions and top-left light across all frames.

Reply exactly:
FRAME 1
<${height} lines>
FRAME 2
<${height} lines>
... through FRAME ${frames}. No fences or prose.`
    : `Draw ONE ${32}x${height} sprite for the recognised thing below.

Name: ${JSON.stringify(name || 'thing')}
Drawing: ${JSON.stringify(drawing || name || 'a small thing')}
Kind: ${kind || 'scenery'}
Move: ${move || 'none'}

Reply with exactly ${height} lines of exactly 32 characters and nothing else.
Keys: . = transparent; ${Object.keys(PALETTE).join(' ')} = the fixed palette.
Palette: ${Object.entries(PALETTE).map(([k, v]) => `${k} ${v}`).join(' · ')}

Style (Final-Fantasy-like 32px monster/object):
- A strong readable silhouette that fills 15-90% of the box, centred, feet/base at the bottom.
- The Drawing is the subject, not an archetype. If it names a support, vehicle, pose or part (a witch riding a broom, an Eiffel Tower's four legs and platforms, a girl in a wheelchair), that feature must be visible. The examples below are style references only.
- Selective dark outline (k) only where needed; 4-6 tones per material (for example k,G,g,l for green); dither or step between tones.
- No smooth gradients, anti-aliasing, text or shadow ellipse. One or two signature features; a face only for a living thing.
- Transparent background: use dots, never a solid bounding rectangle.`;

  return `${frameText}

Keys: . = transparent; ${Object.keys(PALETTE).join(' ')} = the fixed palette.
Palette: ${Object.entries(PALETTE).map(([k, v]) => `${k} ${v}`).join(' · ')}

Style rules for every frame:
- Strong readable silhouette; expressive face for living things; eyes read at 32px; light from the top-left.
- Selective outline: dark only where the form needs it, not a uniform border around every pixel.
- 4-6 tones per material, dithered transitions; no flat blocks or blobs; no cut-out silhouette.
- The Drawing is the subject: named supports, poses and signature features must remain visible.
${REFERENCE ? '- A reference sheet is attached for style only: use its crisp hard pixels, rich selective shading and readable silhouettes; do not copy any of its subjects.\n' : ''}

Worked style references (single 32x32 frames):
Dragon (wings, horns, face):
${example(DRAGON)}

Tower:
${example(TOWER)}

Tree:
${example(TREE)}`;
}

function fixPrompt(prompt, reply, problem, { frames = 1, height = 32 } = {}) {
  return `${prompt}

Your previous reply was rejected: ${problem}
Previous reply:
${String(reply).slice(0, 3500)}

Return the corrected ${frames === 1 ? 'grid' : `FRAME 1 through FRAME ${frames} sections`} only, each with ${height} lines of exactly 32 characters, no fences or prose.`;
}

export function spriteSource(file, base, framesRows) {
  const names = framesRows.map((_, i) => framesRows.length === 1 ? base : `${base}-f${i + 1}`);
  return `// generated by scripts/thing_sprite.mjs from ${file}
${PAL}
${framesRows.map((rows, i) => `sprite(${JSON.stringify(names[i])}, \`
${rows.join('\n')}
\`)`).join('\n\n')}
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
export function validatePng(png, { width = 32, height = 32 } = {}) {
  const dims = execFileSync('identify', ['-format', '%w %h', png], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  if (dims[0] !== width || dims[1] !== height) throw new Error(`sprite PNG is ${dims[0]}x${dims[1]}, need ${width}x${height}`);
  const hist = execFileSync('convert', [png, '-format', '%c', 'histogram:info:'], { encoding: 'utf8' });
  for (const m of hist.matchAll(/#([0-9A-Fa-f]{8})/g)) {
    const hex = m[1].toUpperCase();
    if (hex.slice(6) === '00') continue;                 // transparent
    if (!RGB.has(hex.slice(0, 6))) throw new Error(`sprite uses a colour outside the palette: #${hex}`);
  }
  return dims;
}

export function buildPng({ source, base, outDir, pxlDir = PXL_DIR, requireMode = null, frames = 1, height = 32 }) {
  const started = Date.now();
  const dir = ensurePxl(pxlDir);
  const stage = mkdtempSync(join(tmpdir(), 'kritzel-sprite-'));
  try {
    const art = join(stage, base + '.px.js');
    writeFileSync(art, source);
    const out = join(stage, 'out');
    execFileSync(process.execPath, [join(dir, 'bin', 'pxl.js'), 'build', art, '--out', out, '--no-preview'],
      { timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const frameNames = Array.from({ length: frames }, (_, i) => frames === 1 ? base : `${base}-f${i + 1}`);
    const framePaths = frameNames.map(n => join(out, 'sprites', n + '.png'));
    framePaths.forEach((p, i) => {
      if (!existsSync(p)) throw new Error(`claude-pxl wrote no ${frameNames[i]}.png`);
      validatePng(p, { width: 32, height });
    });
    const strip = join(stage, base + '-strip.png');
    execFileSync('convert', [...framePaths, '-background', 'none', '+append', '-strip',
      '-define', 'png:exclude-chunks=date,time', strip], { stdio: ['ignore', 'pipe', 'pipe'] });
    validatePng(strip, { width: 32 * frames, height });
    if (requireMode && currentMode() !== requireMode)
      throw new Error(`render mode changed to ${currentMode()}: not publishing a ${requireMode} sprite`);
    mkdirSync(outDir, { recursive: true });
    const finalSrc = join(outDir, base + '.px.js');
    const finalPng = join(outDir, base + '.png');
    const tmpSrc = join(outDir, `.${base}.px.js.tmp-${process.pid}`);
    const tmpPng = join(outDir, `.${base}.png.tmp-${process.pid}`);
    writeFileSync(tmpSrc, source);
    copyFileSync(strip, tmpPng);
    renameSync(tmpPng, finalPng);                       // the viewer only needs the PNG: publish it first
    try { renameSync(tmpSrc, finalSrc); } catch (e) {
      throw new Error(`could not publish the sprite source: ${e.message}`);
    }
    return { source: finalSrc, png: finalPng, bytes: statSync(finalPng).size, ms: Date.now() - started, frames, height };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function defaultAsk(prompt, system = SYSTEM) {
  let images = [];
  if (REFERENCE && existsSync(REFERENCE)) {
    try {
      images = [REFERENCE.toLowerCase().endsWith('.jpg') || REFERENCE.toLowerCase().endsWith('.jpeg')
        ? readFileSync(REFERENCE)
        : execFileSync('convert', [REFERENCE, '-quality', '90', 'jpg:-'], { maxBuffer: 20e6 })];
    } catch { /* a broken reference must not stop the sprite */ }
  }
  const r = await oneShot({ system, text: prompt, images, provider: TEXT_PROVIDER, model: TEXT_MODEL, timeoutMs: 90_000 });
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

export function planFor({ name = '', drawing = '', kind = '', move = '', height = null } = {}) {
  const kindNow = kind === 'actor' ? 'actor' : 'scenery';
  const moveNow = moveFor(name, drawing, kindNow, move);
  return {
    kind: kindNow,
    move: moveNow,
    frames: framesFor(kindNow, moveNow),
    fps: fpsFor(kindNow, moveNow),
    height: height || heightFor(name, drawing, kindNow),
  };
}

export async function makeSprite({ name = '', drawing = '', kind = '', move = '', file = '', outDir, reportDir,
  ask = defaultAsk, build = buildPng, pxlDir = PXL_DIR, requireMode = null, height = null } = {}) {
  const base = basename(String(file || name || 'thing')).replace(/\.js$/, '');
  outDir = outDir || join(ROOT, 'viewer', 'pixel', 'sprites');
  reportDir = reportDir || join(ROOT, 'frames', 'generated');
  const started = Date.now();
  const plan = planFor({ name, drawing, kind, move, height });
  const prompt = spritePrompt({ name, drawing, kind: plan.kind, move: plan.move, frames: plan.frames, height: plan.height });
  const report = { file: base + '.js', name, drawing, kind: plan.kind, move: plan.move, frames: plan.frames,
    fps: plan.fps, height: plan.height, provider: TEXT_PROVIDER, model: TEXT_MODEL,
    prompt, calls: [], reply: '', fixed: false, error: null };
  let rows = null, problem = null, reply = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ask(attempt ? fixPrompt(prompt, reply, problem, { frames: plan.frames, height: plan.height }) : prompt);
    report.calls.push({ model: r.model || TEXT_MODEL, provider: r.provider || TEXT_PROVIDER,
      seconds: r.seconds ?? null, cost: r.cost ?? null, fix: attempt > 0 });
    reply = String(r.text ?? '');
    report.reply = reply;
    try {
      rows = parseFrames(reply, { frames: plan.frames, height: plan.height });
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
    const built = await build({ source: spriteSource(base + '.js', base, rows), base, outDir, pxlDir, requireMode,
      frames: plan.frames, height: plan.height });
    report.rows = rows;
    report.frameRows = rows;
    report.source = built.source;
    report.png = built.png;
    report.bytes = built.bytes;
    report.buildMs = built.ms;
    report.stripWidth = 32 * plan.frames;
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
    const plan = planFor({ name, drawing, kind, move, height: a.height ? Number(a.height) : null });
    if (a.promptOnly) { console.log(spritePrompt({ name, drawing, kind: plan.kind, move: plan.move, frames: plan.frames, height: plan.height })); return 0; }
    if (!a.ensure && (a.name === undefined && a.drawing === undefined && a.file === undefined)) {
      throw new Error('name/drawing/file is required (or use --ensure)');
    }
    const outDir = a.out ? resolve(a.out) : join(ROOT, 'viewer', 'pixel', 'sprites');
    const reportDir = a.report ? dirname(resolve(a.report)) : join(ROOT, 'frames', 'generated');
    const report = await makeSprite({ name, drawing, kind, move, file, outDir, reportDir, pxlDir: a.pxl || PXL_DIR,
      requireMode: a['require-mode'] || null, height: a.height ? Number(a.height) : null });
    console.log(JSON.stringify({ ok: true, file: base + '.js', source: report.source, png: report.png,
      bytes: report.bytes, seconds: report.seconds, buildMs: report.buildMs,
      move: report.move, frames: report.frames, fps: report.fps, height: report.height,
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
