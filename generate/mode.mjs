// The active render mode owns the world. The viewer switch writes world-mode.json and archives/empties
// the outgoing world; generation reads the same file for every write. Missing or malformed = 3d.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MODE_FILE = process.env.KRITZEL_WORLD_MODE || join(ROOT, 'world-mode.json');

export function readRenderMode(file = MODE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j?.render === 'pixel' ? 'pixel' : '3d';
  } catch { return '3d'; }
}

export const pixelThingsDirFor = thingsDir => join(dirname(thingsDir), 'pixel', 'things');

export function assertRenderMode(mode, what) {
  const now = readRenderMode();
  if (now !== mode) throw new Error(`render mode is ${now}: refusing ${what}`);
  return now;
}

// Pixel things are the mode's source of truth: { name, paper:{x,y}, drawing, kind, sprite }.
export function readPixelThings(dir) {
  let files = [];
  try { files = readdirSync(dir).filter(f => /^[\w.-]+\.json$/.test(f) && !f.startsWith('.')).sort(); } catch { return []; }
  const out = [];
  for (const file of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (typeof j?.name !== 'string' || !j.name.trim() || typeof j?.drawing !== 'string' || !j.drawing.trim()) continue;
      const p = j.paper;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      out.push({ file, meta: { name: j.name, drawing: j.drawing, paper: { x: p.x, y: p.y } },
        kind: j.kind || 'scenery', sprite: j.sprite || file.replace(/\.json$/, '.png') });
    } catch { /* a half-written or unrelated json is not a thing */ }
  }
  return out;
}
