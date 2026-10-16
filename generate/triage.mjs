// The fast first look at a settled frame (issue #8): one small-model call comparing the sheet before
// and after, ~4 s. Its answer reaches the viewer early (status), decides whether the slow build call
// is needed at all, and gives a tight box when capture's covers the whole frame. The build call stays
// the final word on what gets built. Prompt and settings from QA's benchmark (22 pairs: kind 19/22,
// box 20/22, light 20/22, median 4.4 s, $0.0007 a pair).
import { execFileSync } from 'node:child_process';
import { oneShot } from './claude.mjs';

export const TRIAGE_MODEL = process.env.KRITZEL_TRIAGE_MODEL || 'claude-haiku-5-5';
export const KINDS = ['none', 'new', 'addition', 'crossed_out', 'coloured_in', 'relabel'];

const SYSTEM = `You compare two photos of the same sheet of paper under a camera: BEFORE, then AFTER. A child draws on it.
Answer with ONE line of JSON and nothing else:
{"changed": bool, "kind": "none"|"new"|"addition"|"crossed_out"|"coloured_in"|"relabel", "box": [x,y,w,h]|null, "light": bool, "weather": bool}
changed: did the drawing on the paper meaningfully change (ignore the paper sliding, light, shadows, hands, things off the paper).
kind: new = a new separate drawing; addition = strokes added to an existing drawing; crossed_out = an existing drawing struck through / X-ed / scribbled over; coloured_in = hatching or shading inside an existing drawing; relabel = a word written or crossed out next to a drawing. none if nothing changed.
box: where the change is, in pixels of a 1920x1080 frame (x,y = top-left). light: the changed drawing is a light source (sun, moon, lamp, candle, fire, torch). weather: it is weather (cloud, rain, snow, sun, wind).`;

const small = f => execFileSync('convert', [f, '-resize', '1024x576', '-quality', '85', 'jpg:-'], { maxBuffer: 20e6 });

// → { changed, kind, box: [x, y, w, h] | null, light, weather, seconds, cost } ; null if the answer is unusable
export async function triage(before, after, { signal = null } = {}) {
  const r = await oneShot({ system: SYSTEM, text: 'BEFORE is the first image, AFTER the second. Both are scaled to 1024x576; give the box in 1920x1080 pixels.',
    images: [small(before), small(after)], model: TRIAGE_MODEL, timeoutMs: 60_000, signal });
  let a;
  try { a = JSON.parse(r.text.match(/\{[\s\S]*\}/)[0]); } catch { return null; }
  if (!KINDS.includes(a.kind) || typeof a.changed !== 'boolean') return null;
  const box = Array.isArray(a.box) && a.box.length === 4 && a.box.every(Number.isFinite) && a.box[2] > 0 && a.box[3] > 0 ? a.box.map(Math.round) : null;
  return { changed: a.changed && a.kind !== 'none', kind: a.changed ? a.kind : 'none', box, light: !!a.light, weather: !!a.weather,
    seconds: +r.seconds.toFixed(1), cost: r.cost };
}
