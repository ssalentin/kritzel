#!/usr/bin/env node
// The generation stage: a settled camera frame → viewer/things/<thing>.js, fast.
//
//   node generate/generate.mjs --watch [frames/settled] [--things DIR] [--reports DIR] [--render]
//   node generate/generate.mjs <frame.jpg> [--box x,y,w,h] [--previous before.jpg] [--things DIR] [--reports DIR] [--render]
//
// Per settled frame (format agreed with pipeline-capture: <ts>.jpg renamed in after its <ts>.json
// sidecar { previous, changed_box, reason, ... }):
//   crop to changed_box + margin, downscale → ONE claude -p call (no tools, image inline) that
//   answers NOTHING, UNCLEAR: …, or the module → static + real build() checks (< 1 s) → atomic
//   write to things/. A failed check gets one retry, then one try on the fallback model.
//   Each module is checked and written as soon as it is complete in the streamed reply; on a new
//   sheet with more than two drawings, up to HELPERS parallel calls write some of them.
// Every frame leaves <reports>/<frame>.json: the reply, checks, cost, and timing: seconds from the frame's start to
// each stage (things read, crop, first text, SEEN, first thing written, done; each call's end as "at"). --render also
// renders each written thing in the real viewer (headless) to <reports>/<frame>-<thing>-front.png.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneShot, MODEL, FALLBACK_MODEL, PI_FALLBACK } from './claude.mjs';
import { isPiModel, prewarm } from './pi.mjs';
import { live } from './children.mjs';
import { staticCheck, buildCheck, metaOf } from './check.mjs';
import { SYSTEM, userText, fixText, DETECT_SYSTEM, detectText, oneOfText, DRAFT_NOTE } from './prompts.mjs';
import { islandOf, movePaper } from './place.mjs';
import { safeLine } from '../viewer/dialogues.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
// one call in the report: which model really answered (a pi model may have fallen back to Claude) and its time
// (endedAt becomes "at", seconds since the frame's start, when the report is saved)
const callOf = (r, extra = {}) => ({ model: r.model, seconds: +r.seconds.toFixed(1), cost: r.cost, ...(r.fellBack && { fellBack: r.fellBack }), ...extra, endedAt: Date.now() });

// ---------- existing things: their meta is the registry ----------
async function readThings(dir, paper = {}) {
  const out = [];
  for (const file of readdirSync(dir).filter(f => /^[\w.-]+\.js$/.test(f)).sort()) {
    const code = readFileSync(join(dir, file), 'utf8');
    const ids = [...code.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(x => x[1]);
    const meta = await metaOf(code);         // runs the module's top level, sandboxed
    const m = { name: file, drawing: meta ? '?' : '(does not load)', ...meta };
    if (paper[file]) m.paper = paper[file];  // moved along with the sheet since it was written
    out.push({ file, code, meta: m, ids });
  }
  return out;
}

// Where each thing is on the paper NOW. meta.paper is where it was when its module was written; when
// the sheet moves, capture reports the move (affine) and the watcher moves these positions along, so
// matching and the REMOVE guard keep pointing at the right drawing. { file: { x, y }, _through: frame }
const paperPath = reportsDir => join(reportsDir, 'paper.json');
function readPaper(reportsDir) { try { return JSON.parse(readFileSync(paperPath(reportsDir), 'utf8')); } catch { return {}; } }
function writePaper(reportsDir, map) { const p = paperPath(reportsDir); writeFileSync(p + '.tmp', JSON.stringify(map, null, 1)); renameSync(p + '.tmp', p); }

const slug = s => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ding';
function freeName(base, taken) {
  let n = base, i = 2;
  while (taken.has(n)) n = `${base}-${i++}`;
  return n;
}
const atomicWrite = (path, data) => { const tmp = join(dirname(path), '.' + basename(path) + '.tmp'); writeFileSync(tmp, data); renameSync(tmp, path); };

// changed_box (+ margin) → a JPEG, and where it goes on the island. A tight crop is sharp at 768 px; a whole
// sheet (no trusted box) goes at up to 1568 px (Claude's own limit), so small drawings stay legible
function cropOf(frame, box, previous = null) {
  const [W, H] = execFileSync('identify', ['-format', '%w %h', frame], { encoding: 'utf8' }).split(' ').map(Number);
  const [x, y, w, h] = box || [0, 0, W, H];
  // margin: 15 %, and enough that a small change (a word, a dot, an arm) is seen with the drawings around and attached to it
  const m = Math.max(40, 0.15 * Math.max(w, h), (640 - Math.min(w, h)) / 2);
  const x0 = Math.max(0, Math.round(x - m)), y0 = Math.max(0, Math.round(y - m));
  const x1 = Math.min(W, Math.round(x + w + m)), y1 = Math.min(H, Math.round(y + h + m));
  const crop = f => execFileSync('convert', [f, '-crop', `${x1 - x0}x${y1 - y0}+${x0}+${y0}`, '+repage', '-resize', box ? '768x768>' : '1568x1568>', '-quality', '85', 'jpg:-'], { maxBuffer: 20e6 });
  const image = crop(frame), before = previous && existsSync(previous) ? crop(previous) : null;
  const px = (x + w / 2) / W, py = (y + h / 2) / H;           // frame ≈ paper: no paper detection yet
  const [ix, iz] = islandOf(px, py);
  const height = box ? +Math.min(3.5, Math.max(0.8, (h / H) * 4.5)).toFixed(1) : 2;
  const area = [x0 / W, y0 / H, x1 / W, y1 / H];                // the crop, as paper fractions
  return { image, before, area, place: [+ix.toFixed(2), +iz.toFixed(2), +px.toFixed(2), +py.toFixed(2)], height };
}

const stripFences = t => t.trim().replace(/^```(?:js|javascript)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
const MARK = '// generated by generate/ from ';

// "### NEW", "### UPDATE file.js", "### REMOVE file.js", "### UNCLEAR" sections → [{ kind, file, body }]
export function parseReply(text) {
  const t = text.replace(/^\s*SEEN:.*\n?/, '').trim();       // the narration line before the sections
  if (/^NOTHING\b/.test(t)) return [];
  if (/^UNCLEAR\b/.test(t)) return [{ kind: 'UNCLEAR', file: null, body: t.replace(/^UNCLEAR:?\s*/, '') }];   // without its ### header
  const parts = t.split(/^###\s*(NEW|UPDATE|REMOVE|UNCLEAR)\b[ \t]*(\S*)[ \t]*$/m);
  if (parts.length < 4) {
    if (/export\s+const\s+meta\b/.test(t) && /export\s+(async\s+)?function\s+build\b/.test(t)) return [{ kind: 'NEW', file: null, body: stripFences(t) }];   // a module without its header
    throw new Error('reply has no ### sections: ' + t.slice(0, 120));
  }
  const out = [];
  for (let i = 1; i < parts.length; i += 3) out.push({ kind: parts[i], file: parts[i + 1] || null, body: stripFences(parts[i + 2]) });
  return out;
}

// what the status pill tells the child (#18), from the reply so far: the SEEN line ({ de, en, den,
// the, name_en } per NEW/UPDATE section, in order) and how many of those sections have begun.
// Model text shown straight to children: every phrase passes the child-safe filter, or is left out.
const kid = (de, en) => {
  const ok = (x, lang) => typeof x === 'string' && x.length > 0 && x.length <= 40 && safeLine(x, lang);
  return ok(de, 'de') && ok(en, 'en') ? { de, en } : null;
};
export function narrate(text) {
  let seen = [];
  const m = text.match(/^\s*SEEN:\s*(\[.*\])[ \t]*\r?\n/);   // only once the line is complete
  if (m) try { seen = JSON.parse(m[1]).filter(x => x && typeof x === 'object'); } catch { /* not usable: no narration */ }
  const begun = (text.match(/^###\s*(NEW|UPDATE)\b/gm) || []).length;
  return { seen, begun };
}
export const seenOf = seen => seen.map(x => kid(x.de, x.en)).filter(Boolean);
export const nowOf = x => (x && kid(x.den, x.the)) || null;
export const whyOf = body => { try { const j = JSON.parse(body.match(/^KIDS:\s*(\{.*\})\s*$/m)?.[1]); return kid(j.de, j.en); } catch { return null; } };

// one module: check it; on failure ask for a fix (same model, then the fallback). → { code, model } | { problems }
// at most n calls of a kind at once, the rest wait their turn (the plan is shared, and each claude is a process)
export function slots(n) {
  let running = 0;
  const queue = [];
  return async fn => {
    if (running >= n) await new Promise(ok => queue.push(ok));
    running++;
    try { return await fn(); } finally { running--; queue.shift()?.(); }
  };
}
// fix calls run alongside each other on a busy sheet: at most FIX_SLOTS at once
const FIX_SLOTS = 2, fixSlot = slots(FIX_SLOTS);
// builds of a listed sheet: through pi (DeepSeek) all at once is the point; on the Claude plan as many as the
// old main call + helpers (4)
// Two stages (Sebastian, 15:55: DeepSeek is fast but its models look much worse): with KRITZEL_DRAFT_MODEL set, a
// fast draft by that model is written first, as one stage did; then the final model (KRITZEL_MODEL, Sonnet) builds
// the same drawing from the same image and replaces the draft in its file (same name, actor ids, paper place), at
// most FINAL_SLOTS at once, in the background. Unset: one stage, as before.
export const DRAFT_MODEL = process.env.KRITZEL_DRAFT_MODEL || null;
const BUILD = DRAFT_MODEL || MODEL;                    // what lists and builds first
const FINAL_SLOTS = +process.env.KRITZEL_FINAL_SLOTS || 4, finalSlot = slots(FINAL_SLOTS);
const FINAL_RETRY_MS = (+process.env.KRITZEL_FINAL_RETRY_S || 180) * 1000;
const BUILD_SLOTS = +process.env.KRITZEL_BUILD_SLOTS || (isPiModel(BUILD) ? 8 : 4), buildSlot = slots(BUILD_SLOTS);
const onlyHolds = problems => problems.length > 0 && problems.every(p => /^(holds|heldBy) names actor/.test(p));

// deferHolds: when the only problem is a held creature not written yet, say so at once instead of
// asking for a fix (which would just drop the hold)
// extra(info) → more problems, from what the check measured (a creature hanging with nothing above it)
async function finish({ body, model, frame, images, takenIds, keepIds, oldName = null, calls, deferHolds = false, extra = null, fixModels = [BUILD, FALLBACK_MODEL] }) {
  let code = body.split('\n').filter(l => !l.startsWith(MARK)).join('\n').trim(), problems, simSkipped = null, info = {};
  for (const fixModel of [null, ...fixModels]) {
    if (fixModel) {
      if (deferHolds && onlyHolds(problems)) return { problems, held: true, info };
      const r = await fixSlot(() => oneShot({ system: SYSTEM, text: fixText({ problems, code }), images: images.slice(-1), model: fixModel }));   // the area now
      calls.push(callOf(r, { fix: true, fixing: problems }));
      code = stripFences(r.text).replace(/^###.*\n/, '');
      model = r.model;
    }
    const full = `${MARK}frames/settled/${basename(frame)} (${model})\n${code}\n`;
    problems = staticCheck(full);
    if (!problems.length) {
      const b = await buildCheck(full, { takenIds });
      problems = b.problems;
      simSkipped = b.info?.simSkipped || null;
      info = b.info || {};
      // a module from before the one-figure rule may hold several figures: updating it is not splitting it
      if (keepIds.length > 1) problems = problems.filter(p => !/actors in one module/.test(p));
      // an updated thing keeps its actor ids (the sim remembers friendships), unless it was renamed into
      // something else that is no longer alive (figures → "Kerzen")
      const renamed = oldName && code.match(/name:\s*['"]([^'"]+)['"]/)?.[1] !== oldName;
      if (!(renamed && !b.info.actors?.length)) for (const id of keepIds) if (!b.info.actors?.includes(id)) problems.push(`keep the actor id "${id}" (the sim remembers its friendships)`);
      // a house that hops and talks (live: 'Eins, zwei, drei... ich komme!'): a building or object is only an actor
      // when a face is drawn on it
      if (b.info.actors?.length && notAlive(code)) problems.push('it is a building or an object with no drawn face, so it is not alive: no actor (return actors: [], keep it as scenery with obstacles)');
      // solid blobs (Sebastian: 'always solid blobs'): a drawing of 4+ parts built almost all from spheres and boxes
      // gets one fix call for real silhouettes, on the first pass only: spheres are often right (a snowman, grapes, a
      // caterpillar of balls), so after a fix whatever passes the other checks is taken. Not for a draft (speed)
      // the glow is a look, not correctness: asked for once, then taken (a candle must not vanish over a missing glow)
      if (!problems.length && !fixModel) problems.push(...unlit(code, info));
      // a hand-built shape wound inward renders black: asked once to rewind, then taken (a hill must not vanish over shading)
      if (!problems.length && !fixModel && info.inwardMeshes) problems.push(`${info.inwardMeshes} hand-built shape${info.inwardMeshes > 1 ? 's' : ''} with its faces pointing inward (it renders black from outside): wind each triangle the other way (a, c, b instead of a, b, c), or build it with ExtrudeGeometry or LatheGeometry`);
      if (!problems.length && !fixModel) problems.push(...plainWater(code, info));
      if (!problems.length && !fixModel && (!DRAFT_MODEL || model === MODEL)) problems.push(...blobs(code, info));
      if (!problems.length && extra) problems.push(...extra(info));
    }
    if (!problems.length) return { code: full, model, info, warnings: [
      ...(info.tris > TRIS ? [`${info.tris} triangles (more than ${TRIS}): heavy for the viewer, which draws every thing at once`] : []),
      ...(/^\/\/ parts:/m.test(code) ? [] : ['no // parts: list (a thinking aid for the model; module accepted)']),
      ...(simSkipped ? [`not run in the sim (run npm ci in generate/): ${simSkipped}`] : []),
    ] };
  }
  return { problems };
}

// a module that only shows writing (Sebastian: "Sqichy" in 3D letters): a word alone is never a thing. By what it says
// it is (meta.drawing and name), so a drawing with its label ("a house labelled Haus") is not caught.
const WORD = /^\s*(?:the |a |an )?(?:(?:hand-?written|written|scribbled|pencil|pen|blue|red|black|big|small|grey|gray)\s+)*(?:word|words|text|title|name|letters|writing|signature|lettering)\b/i;
export function wordOnly(code) {
  const drawing = code.match(/drawing:\s*['"]([^'"]*)['"]/)?.[1] || '', name = code.match(/name:\s*['"]([^'"]*)['"]/)?.[1] || '';
  return WORD.test(drawing) || /(?:^|[-\s])(?:wort|schriftzug|titel|text|buchstaben)$/i.test(name);
}

// a building or object (by its name) whose parts and drawing mention no face: not a figure. Flying vehicles are
// left out on purpose: they are actors (they fly)
const OBJECT = /(?:^|[\s-])(?:haus|house|hütte|hut|schloss|castle|turm|tower|zelt|tent|zaun|fence|tisch|table|stuhl|chair|bett|bed|lampe|lamp|kiste|box|karton|regal|shelf|brücke|bridge|mauer|wall|gefängnis|jail)(?:$|[\s-])/i;
const FACE = /\b(?:auge|augen|eye|eyes|gesicht|face|mund|mouth|smile|smiling|lächel\w*|nase|nose)\b/i;
export function notAlive(code) {
  const name = code.match(/\bmeta\s*=\s*\{[^}]*?\bname:\s*['"]([^'"]+)['"]/)?.[1] || '', drawing = code.match(/drawing:\s*['"]([^'"]*)['"]/)?.[1] || '';
  const parts = (code.match(/^\/\/ parts:.*$/gm) || []).join(' ');
  return OBJECT.test(` ${name} `) && !FACE.test(`${drawing} ${parts}`);
}

// what kind of drawing a name or description is, roughly: the same stick figure is "Strichfigur" on one frame and
// "ein Mensch" on the next, so the same sheet seen again is matched by kind, not by exact name
const KINDS = [['figure', /strich|person|mensch|mann|männchen|maennchen|kind|junge|mädchen|maedchen|figur|frau/i], ['bird', /vogel|bird/i],
  ['sun', /sonne|sun/i], ['cloud', /wolke|cloud/i], ['house', /haus|house/i], ['tree', /baum|tree/i], ['flower', /blume|flower/i],
  ['cat', /katze|kätzchen|cat/i], ['dog', /hund|dog/i], ['mouse', /maus|mouse/i], ['fish', /fisch|fish/i]];
export const kindOf = s => KINDS.find(([, re]) => re.test(s))?.[0] || String(s).toLowerCase().replace(/^(ein|eine|einen|der|die|das|a|an|the)\s+/, '').split(/\s+/)[0];
// list entries that are things already in the book: the ones the list names (inBook), and those that match a book
// thing by kind AND place. The sheet may have moved and turned (live 154727: shifted, turned, scaled), so the place
// match fits one similarity (shift, turn, scale) from two same-kind pairs and keeps the fit that lines up the most
// (each entry within 0.12 of an unmatched same-kind book thing). It is the same sheet only when that fit matches 3
// or more entries of 2 or more kinds, and at least 60% of the list: a new sheet of familiar things (3 birds again)
// does not line up with the old one.
export function againInBook(listed, existing) {
  const names = new Set(existing.map(t => String(t.meta.name).toLowerCase()));
  const named = listed.filter(e => e.inBook && names.has(e.inBook.toLowerCase()));
  // stale places count too: the fit finds the sheet's move itself (stale only guards REMOVE). After the paper was taken
  // away and put back, every place was stale and the whole sheet was built again (pipeline-capture's replay)
  const book = existing.filter(t => t.meta.paper && typeof t.meta.paper.x === 'number')
    .map(t => ({ k: kindOf(t.meta.name), x: t.meta.paper.x, y: t.meta.paper.y }));
  const ents = listed.map(e => ({ e, k: kindOf(e.de), x: (e.box[0] + e.box[2]) / 2, y: (e.box[1] + e.box[3]) / 2 }));
  const pairs = [];
  for (const q of ents) for (const p of book) if (p.k === q.k) pairs.push([p, q]);
  let best = [], bestFit = null;
  const tries = pairs.length > 60 ? pairs.slice(0, 60) : pairs;              // enough for a sheet; bounded work
  for (const [p1, q1] of tries) for (const [p2, q2] of tries) {
    if (p1 === p2 || q1 === q2) continue;
    const dx = p2.x - p1.x, dy = p2.y - p1.y, d2 = dx * dx + dy * dy;
    if (d2 < 0.0025) continue;                                               // too close to fix a turn
    // s = (q2 - q1) / (p2 - p1) as complex numbers; t = q1 - s p1
    const ex = q2.x - q1.x, ey = q2.y - q1.y;
    const sr = (ex * dx + ey * dy) / d2, si = (ey * dx - ex * dy) / d2, scale = Math.hypot(sr, si);
    if (scale < 0.5 || scale > 2) continue;
    const tx = q1.x - (sr * p1.x - si * p1.y), ty = q1.y - (si * p1.x + sr * p1.y);
    const free = new Set(book), got = [];
    for (const q of ents) {
      let hit = null, near = 0.12;
      for (const p of free) if (p.k === q.k) { const d = Math.hypot(sr * p.x - si * p.y + tx - q.x, si * p.x + sr * p.y + ty - q.y); if (d < near) { near = d; hit = p; } }
      if (hit) { free.delete(hit); got.push(q); }
    }
    if (got.length > best.length) { best = got; bestFit = { sr, si, tx, ty }; }
  }
  const same = best.length >= 3 && new Set(best.map(q => q.k)).size >= 2 && best.length >= 0.6 * listed.length;
  // the list's in_book counts only when the places agree it is the same sheet: it knows the book's things only by
  // their descriptions, so a new 'bird with spread wings' can come back as the book's Vogel
  // the fit goes along: when the same sheet came back moved, the paper places move with it (keepPlacesIfNothing)
  return Object.defineProperty(same ? [...new Set([...named, ...best.map(q => q.e)])] : [], 'fit', { value: same ? bestFit : null });
}

// a drawing that gives light (by its name or what it shows) must declare light with its glowing part as object3D, so the
// viewer can make it glow (Sebastian: candles, lamps, lanterns, fire, sun, moon, stars). Not a starfish or a sunflower
const LUMINOUS = /(?:^|[\s-])(?:kerzen?|candles?|lampe|lamp|laterne|lantern|feuer|fire|lagerfeuer|campfire|fackel|torch|taschenlampe|flashlight|leuchtturm|lighthouse|sonne|sun|mond|moon|sterne?|stars?|sternchen)(?:$|[\s-.,!])/i;
const NOT_LUMINOUS = /seestern|starfish|sonnenblume|sunflower|sonnenbrille|sunglasses|sonnenschirm|parasol/i;
export function unlit(code, info) {
  const name = code.match(/\bmeta\s*=\s*\{[^}]*?\bname:\s*['"]([^'"]+)['"]/)?.[1] || '', drawing = code.match(/drawing:\s*['"]([^'"]*)['"]/)?.[1] || '';
  // by its name, or by what the drawing is (the head of its description: 'two candles, ...'), not by a detail in it
  // ('a gold star medal', 'a creature with a star on top', 'a fire rescue boat' are not lights)
  const head = /^\s*(?:a|an|the|one|two|three|four|\d+)?\s*(?:[\w-]+\s+){0,2}?(?:candles?|lamps?|lanterns?|fires?|campfire|torch(?:es)?|flashlight|lighthouse|sun|moon|stars?)(?=\s*(?:$|[,.;]|with\b|and\b|on\b|in\b|that\b|labelled\b|glowing\b|shining\b))/i;
  const luminous = (LUMINOUS.test(` ${name} `) || head.test(drawing)) && !NOT_LUMINOUS.test(`${name} ${drawing}`);
  if (!luminous || (info?.lights || []).some(l => l.glows)) return [];
  return ['it is a drawing that gives light: return light ({ kind: \'sun\' | \'moon\' | \'lamp\', object3D: the glowing part, color, intensity }) with the glowing mesh (the flame, the bulb, the sun disc, the star) as object3D and an emissive material'];
}

// drawn water built by hand (grey ribbons, a blue box) instead of the engine's ctx.water, which is always real moving
// blue water (orch: the rock's waterfall came out pale grey in 2 of 3 runs): asked once to use ctx.water
const WATER = /\b(?:water|waterfall|river|stream|brook|pond|lake|wasser|wasserfall|fluss|bach|teich)\b/i;   // not "see" (lake): it is also English
export function plainWater(code, info) {
  const parts = (code.match(/^\/\/ parts:.*$/gm) || []).join(' ');
  if (!WATER.test(parts) || (info?.waterCalls ?? 1) > 0) return [];
  return ['its parts list has water, but it builds no ctx.water: build drawn water with the engine (ctx.water.river along the drawn strokes on a surface, ctx.water.waterfall where it falls over an edge, ctx.water.pond where it collects), never from hand-made shapes, so it is real moving blue water'];
}

// 14 of 219 archived modules: giraffes, parrots, a hippo of spheres and boxes
const TRIS = +process.env.KRITZEL_TRIS || 30000;            // per thing; above it is a warning, not a rejection
export function blobs(code, info) {
  const g = info?.geoms || {}, n = Object.values(g).reduce((a, x) => a + x, 0), blob = (g.SphereGeometry || 0) + (g.BoxGeometry || 0);
  const parts = (code.match(/^\/\/ parts:/gm) || []).length;
  if (parts < 4 || n < 4 || blob < 0.85 * n) return [];
  return [`${blob} of its ${n} shapes are spheres and boxes, for a drawing of ${parts} parts: build each part's real silhouette as drawn (tubes along the drawn limbs, tails and strokes; extruded outlines for flat parts like ears, wings and fins; lathed profiles for round parts; details as separate pieces), a sphere only where the drawing is a ball`];
}

// ---------- a new sheet: list its drawings first ----------
export const DETECT_MODEL = process.env.KRITZEL_DETECT_MODEL || BUILD;
// → [{ box: [x0, y0, x1, y1] (image fractions), what, de, en, den, the, name_en }], [] for an empty sheet, or
// null when the list is unusable (the caller then asks the one main call). Model text goes to the child only
// through seenOf/nowOf (the child-safe filter) and to the builders as a description, never run.
const str = (x, n) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;
// up: from what the list call sees, not what it judges: asked "which way up", DeepSeek said upright for a sun
// with its eyes below its mouth three times out of three; asked where the eyes are, it saw it every time.
// A creature drawn hanging head-down (a bat under its branch) has its eyes below its mouth too: not turned.
export function parseList(text) {
  let j;
  try { j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; }
  if (!Array.isArray(j?.things)) return null;
  const out = [];
  for (const t of j.things.slice(0, 16)) {
    const b = Array.isArray(t?.box) && t.box.length === 4 && t.box.every(v => typeof v === 'number' && isFinite(v)) ? t.box.map(v => Math.min(1, Math.max(0, v))) : null;
    if (!b || b[2] <= b[0] || b[3] <= b[1] || !str(t.de, 60) || !str(t.en, 60) || !str(t.what, 300)) continue;
    if (WORD.test(t.what) || /^(?:ein|das|der)\s+(?:wort|schriftzug|titel|text)\b/i.test(t.de)) continue;   // a word alone is no drawing
    out.push({ ...(str(t.in_book, 60) && { inBook: t.in_book }), box: b.map(v => +v.toFixed(3)), up: t.face === 'eyes below mouth' && t.hangs !== true ? 'upside down' : 'upright',
      // the words of its speech or thought bubble, only when they pass the child-safe filter (they become its lines)
      ...(t.says && typeof t.says.text === 'string' && t.says.text.length <= 60 && safeLine(t.says.text, 'de') && ['speech', 'thought'].includes(t.says.kind) && { says: { text: t.says.text.trim(), kind: t.says.kind } }),
      what: t.what, de: t.de, en: t.en, den: str(t.den, 60) ? t.den : t.de, the: str(t.the, 60) ? t.the : t.en, name_en: str(t.name_en, 40) ? t.name_en : t.en });
  }
  return out;
}
async function detectSheet({ images, existing, calls }) {
  try {
    const r = await oneShot({ system: DETECT_SYSTEM, text: detectText({ existing }), images: images.slice(-1), model: DETECT_MODEL, timeoutMs: 40_000 });
    calls.push(callOf(r, { detect: true }));
    const list = parseList(r.text);
    if (!list) log(`the list of drawings is unusable, asking the main call: ${r.text.slice(0, 160)}`);
    return list;
  } catch (e) { log(`listing the drawings failed, asking the main call: ${e.message}`); return null; }
}

// ---------- one settled frame ----------
// the status's build list (generate.things: one row per drawing of the current sheet) belongs to one frame at a time:
// a frame's late clear must not wipe a newer frame's list
let thingsOwner = null;
const THINGS_LINGER_MS = +process.env.KRITZEL_THINGS_LINGER_MS || 10_000;
// a new sheet with more than two drawings is written by the main call and up to HELPERS parallel calls
const HELPERS = 3, PARALLEL = process.env.KRITZEL_PARALLEL !== '0';
// onLater({ written }): things written after processFrame returned (a final's split parts)
// beforeFirstWrite(): awaited once, right before the frame's first thing is written (switch mode archives the old
// world there, so a sheet that yields nothing never opens an empty world); if it fails, nothing is written
export async function processFrame(frame, { thingsDir, reportsDir, box = null, previous = null, bigChange = false, render = false, newSheet = false, onProgress = () => {}, onLater = () => {}, beforeFirstWrite = null }) {
  mkdirSync(reportsDir, { recursive: true });
  const name = basename(frame).replace(/\.\w+$/, '');
  const settledAt = statSync(frame).mtimeMs;
  // timing: where the time goes, in seconds since this frame's start (waited: from settling to the start)
  const t0 = Date.now(), T = () => +((Date.now() - t0) / 1000).toFixed(1);
  let endThings = null;
  const report = { frame, box, previous, started: new Date(t0).toISOString(), timing: { waited: +((t0 - settledAt) / 1000).toFixed(1) }, calls: [], written: [], removed: [], rejected: [], unclear: [] };
  const mark = k => { report.timing[k] ??= T(); };
  const save = () => {
    for (const c of report.calls) if (c.endedAt) { c.at = +((c.endedAt - t0) / 1000).toFixed(1); delete c.endedAt; }
    writeFileSync(join(reportsDir, name + '.json'), JSON.stringify(report, null, 1));
  };
  try {
    // switch mode: the new world starts empty (the old one is archived before the first write), with no old paper
    // places either: the first write must not bring the old map (and its _through) back (review of 191fb91)
    const paper = newSheet === 'switch' ? { _through: basename(frame) } : readPaper(reportsDir);
    const existing = newSheet === 'switch' ? [] : await readThings(thingsDir, paper);
    mark('things');
    const { image, before, area, place, height } = cropOf(frame, box, previous);
    mark('crop');
    const images = before ? [before, image] : [image];
    const files = new Set(existing.map(t => t.file.replace(/\.js$/, '')));
    let said = { seen: [], begun: 0 }, told = '';
    const tell = p => { const k = JSON.stringify(p); if (k !== told) { told = k; try { onProgress(p); } catch { /* narration never breaks a frame */ } } };
    // the build list for the viewer's queue (Sebastian: show what is being built, often several at once):
    // [{ name: { de, en }, state: listed | building | draft | done | failed, file? }], at most 16
    const things = [];
    // at every end of the frame (also a failed main call or an error): rows still listed or building were not built;
    // then the list goes, 10 s after the finals, unless a newer frame owns it
    endThings = () => {
      things.forEach((t, k) => { if (t && (t.state === 'listed' || t.state === 'building')) thingState(k, 'failed'); });
      Promise.allSettled(finals).then(() => setTimeout(() => { if (thingsOwner === name) { thingsOwner = null; try { onProgress({ things: [] }); } catch { /* */ } } }, THINGS_LINGER_MS).unref?.());
    };
    const showThings = () => { thingsOwner = name; try { onProgress({ things: things.filter(Boolean).slice(0, 16) }); } catch { /* never breaks a frame */ } };
    const listThings = () => {
      let added = false;
      said.seen.forEach((x, k) => { if (!things[k]) { things[k] = { name: kid(x.de, x.en) || { de: 'etwas', en: 'something' }, state: 'listed' }; added = true; } });
      if (added) showThings();
    };
    const thingState = (k, state, file = null) => {
      if (k == null || !things[k]) return;
      things[k] = { ...things[k], state, ...(file && { file }) };
      showThings();
    };
    const numbered = secs => { let n = 0; for (const x of secs) if (x.kind === 'NEW' || x.kind === 'UPDATE') x.n = n++; return secs; };   // n: its entry in SEEN
    const ask = userText({ existing, place, height, takenIds: existing.flatMap(t => t.ids), hasBefore: !!before, newSheet });

    // A NEW/UPDATE section is checked (and fixed if needed) as soon as it is complete in the stream (the
    // next ### header has begun), alongside the others; only writing it is one at a time, so ids and file
    // names stay collision-free. A thing that holds a creature written later (a branch and its sloth) waits
    // until the end.
    const renders = [], waiting = [], pending = [], sent = new Set();
    let lock = Promise.resolve(), halted = false, firstWrite = null;
    // A creature built up in the air hangs or perches on something (Sebastian: the sloth floated with its
    // pole). Something must be above it: in its own module, written in this frame, or already in the book
    // (its box, moved by where the viewer placed it). Otherwise it waits for the rest of the frame, then
    // gets one fix: add what it hangs from.
    const boxes = [];
    let inBook = null;
    async function bookBoxes() {
      if (inBook) return inBook;
      let placed = {};
      try { placed = JSON.parse(readFileSync(join(thingsDir, 'placement.json'), 'utf8')); } catch { /* none yet */ }
      inBook = [];
      for (const t of existing) {
        const b = (await buildCheck(t.code, { takenIds: [] }).catch(() => null))?.info?.box;
        const [dx, dz] = placed[t.file] || [0, 0];
        if (b) inBook.push({ file: t.file, min: [b.min[0] + dx, b.min[1], b.min[2] + dz], max: [b.max[0] + dx, b.max[1], b.max[2] + dz] });
      }
      return inBook;
    }
    const covered = (h, file) => [...boxes, ...(inBook || []), ...waiting.map(w => w.box).filter(Boolean)].some(b => b.file !== file &&
      (b.max[1] >= h.top - 0.3 || Math.abs(b.max[1] - h.bottom) <= 0.3) &&                  // hangs from it, or sits on it
      b.min[0] - 0.3 <= h.x && h.x <= b.max[0] + 0.3 && b.min[2] - 0.3 <= h.z && h.z <= b.max[2] + 0.3);
    const hangingLoose = file => info => (info?.hanging || []).filter(h => !h.supported && !covered(h, file)).map(h =>
      `actor ${h.id} is built up in the air (y ${h.bottom} to ${h.top}) with nothing to hang from or sit on: add it to this module as scenery outside its rig (a branch on a short trunk over its hands, or the swing, nest or wall under it, as drawn), and return holds: [{ actor: '${h.id}', x: ${h.x}, z: ${h.z}, r: 0.4 }]`);
    const takenNow = old => [...existing.filter(t => t !== old).flatMap(t => t.ids), ...report.written.flatMap(w => w.ids)];
    const write = (s, last = false) => {
      const job = (async () => {
        const old = s.kind === 'UPDATE' ? existing.find(t => t.file === s.file) : null;
        if (s.kind === 'UPDATE' && !old) { thingState(s.n, 'failed'); report.rejected.push({ kind: s.kind, file: s.file, problems: ['no such thing to update'] }); log(`${name}: UPDATE of unknown ${s.file} ignored`); return; }
        if (s.kind === 'NEW' && wordOnly(s.body)) { thingState(s.n, 'failed'); report.rejected.push({ kind: s.kind, problems: ['a written word alone is not a thing'] }); log(`${name}: a word alone, not built`); return; }   // no fix call: nothing to fix
        tell({ seen: seenOf(said.seen), now: nowOf(said.seen[s.n]) });
        thingState(s.n, 'building');
        const check = (takenIds, extra = null) => finish({ body: s.body, model: BUILD, frame, images: s.images || images, takenIds, keepIds: old?.ids || [], oldName: old?.meta.name || null, calls: report.calls, deferHolds: !last, extra });
        const f = await check(takenNow(old));
        const run = lock.then(() => commit(s, old, f, last, check));
        lock = run.catch(() => {});                             // one failed write must not block the next ones
        await run;
      })().catch(e => {                                         // a failed fix call (timeout, limit) costs this one thing, not the watcher
        thingState(s.n, 'failed');
        report.rejected.push({ kind: s.kind, file: s.file, problems: [`not written: ${e.message.slice(0, 200)}`] });
        log(`${name}: ${s.kind} ${s.file || ''} not written: ${e.message}`);
      });
      pending.push(job);
      return job;
    };
    async function commit(s, old, f, last, check) {
      // written meanwhile by a parallel section with the same actor id: check again against what is there now
      if (f.code && [...f.code.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].some(x => takenNow(old).includes(x[1]))) f = await check(takenNow(old));
      let thingName = (f.code || s.body).match(/name:\s*['"]([^'"]+)['"]/)?.[1] || 'Ding';
      if (!f.code && !last && onlyHolds(f.problems)) { waiting.push({ s, box: f.info?.box && { file: '(waiting)', ...f.info.box } }); return; }
      if (f.code && (f.info?.hanging || []).some(h => !h.supported)) {
        await bookBoxes();
        if (hangingLoose(old?.file)(f.info).length) {
          if (!last) { waiting.push({ s, hangs: true }); return; }   // what it hangs from may come later in this frame
          f = await check(takenNow(old), hangingLoose(old?.file));
        }
      }
      if (!f.code) { thingState(s.n, 'failed'); report.rejected.push({ kind: s.kind, file: s.file, name: thingName, problems: f.problems }); log(`${name}: REJECTED ${s.kind} ${s.file || thingName}: ${f.problems.join('; ')}`); return; }
      // a NEW thing's name is unique in the book ("Strichfigur 2"): dialogues and quests name figures, and four
      // "Strichfigur" made the dialogue writer invent speakers (live: 6 of 12 dropped)
      if (!old) {
        const taken = new Set([...existing.map(t => String(t.meta.name).toLowerCase()), ...report.written.map(w => w.name.toLowerCase())]);
        if (taken.has(thingName.toLowerCase())) {
          let n = 2;
          while (taken.has(`${thingName} ${n}`.toLowerCase())) n++;
          const unique = `${thingName} ${n}`, q = thingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          f = { ...f, code: f.code.replace(new RegExp(`(name:\\s*)(['"])${q}\\2`, 'g'), (_, a, b) => `${a}${b}${unique}${b}`) };
          thingName = unique;
        }
      }
      if (beforeFirstWrite) await (firstWrite ||= Promise.resolve().then(beforeFirstWrite));
      const base = old ? old.file.replace(/\.js$/, '') : freeName(slug(thingName), files);
      files.add(base);
      const file = base + '.js';
      // a draft says so (meta.draft: true), so the viewer can give it a pencil look until its final, which rewrites the
      // whole module, replaces it
      const isDraft = DRAFT_MODEL && f.model !== MODEL && s.kind === 'NEW';
      if (isDraft) f = { ...f, code: f.code.replace(/export\s+const\s+meta\s*=\s*\{/, m => `${m} draft: true,`) };
      atomicWrite(join(thingsDir, file), f.code);
      if (f.info?.box) boxes.push({ file, ...f.info.box });
      const pm = f.code.match(/paper:\s*\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+)/);
      if (pm) { paper[file] = { x: +pm[1], y: +pm[2] }; writePaper(reportsDir, paper); }
      const latency = +((Date.now() - settledAt) / 1000).toFixed(1);
      const ids = [...f.code.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(x => x[1]);
      const made = kid(thingName, said.seen[s.n]?.name_en || thingName);
      mark('firstWritten');
      report.written.push({ kind: s.kind, file, name: thingName, model: f.model, latency, at: T(), ids, ...(made && { made }), ...(f.warnings.length && { warnings: f.warnings }) });
      log(`${name}: ${s.kind === 'UPDATE' ? 'UPDATED' : 'WROTE'} ${file} (${thingName}) by ${f.model}, ${latency}s after the frame settled`);
      renders.push({ base, file, code: f.code });
      thingState(s.n, DRAFT_MODEL && f.model !== MODEL && s.kind === 'NEW' ? 'draft' : 'done', file);
      // finals for new drafts only: an UPDATE's final would need its own question (the old module, what changed)
      if (DRAFT_MODEL && f.model !== MODEL && s.kind === 'NEW') finals.push(finalOf({ s, file, draft: f.code, thingName, ids, draftBox: f.info?.box }));
    }
    // the final build of one drafted drawing: the final model, the same image and question, told what the book already
    // knows about it (name, actor ids, start, paper place), checked like any module, fixed only by the final model.
    // It replaces the draft in its file unless the file changed meanwhile (a later frame updated or removed it); if it
    // fails, the draft stays.
    const finals = [];
    if (DRAFT_MODEL) report.finals = [];
    // The final must stand where the draft stands: the viewer adds its saved placement offset to the module's own
    // coordinates, so a final built elsewhere would land shifted (into a neighbour). And a creature up in the air needs
    // something to hang from, as for the draft (hang-support).
    const centre = b => b && [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
    // split: the draft covered several things, so its first part need only stand within the draft's area
    const sameSpot = (draftBox, split = false) => info => {
      const a = centre(draftBox), b = centre(info?.box);
      if (!a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.3) return [];
      if (split && b[0] >= draftBox.min[0] - 0.3 && b[0] <= draftBox.max[0] + 0.3 && b[1] >= draftBox.min[2] - 0.3 && b[1] <= draftBox.max[2] + 0.3) return [];
      return [`it stands centred at x ${b[0].toFixed(2)}, z ${b[1].toFixed(2)}, but this thing stands at x ${a[0].toFixed(2)}, z ${a[1].toFixed(2)} in the book: build it centred there (move its group, its scenery and its actor's start by ${(a[0] - b[0]).toFixed(2)}, ${(a[1] - b[1]).toFixed(2)})`];
    };
    // A final that fails (its checks or its call) is tried once more FINAL_RETRY later, off the busy path; if that fails
    // too, the draft drops its draft flag and stands as a plain thing: a figure never stays 'unfinished' for good in a
    // child's book (orch, 10-18)
    function finalOf({ s, file, draft, thingName, ids, draftBox, attempt = 1 }) {
      return finalSlot(async () => {
        const path = join(thingsDir, file);
        const base = s.prompt || `${ask}\n\nYou build only this one drawing: ${said.seen[s.n]?.de || thingName}. Reply with just its one ### NEW section.`;
        const start = draft.match(/start:\s*\[[^\]]*\]/)?.[0], paperAt = draft.match(/paper:\s*\{[^}]*\}/)?.[0];
        const at = centre(draftBox);
        const text = `${base}

A quick draft of this drawing is in the book now (below)${at ? `, centred at x ${at[0].toFixed(2)}, z ${at[1].toFixed(2)}: build yours centred there too` : ''}. Build the drawing properly yourself, from the image, not from the draft's shapes. Keep what the book already knows about it: name '${thingName}'${ids.length ? `, actor id${ids.length > 1 ? 's' : ''} ${ids.map(i => `'${i}'`).join(', ')}${start ? ` (${start})` : ''}` : ''}${paperAt ? `, meta ${paperAt}` : ''}. Usually it is one thing: reply with its one ### NEW section. But the draft may have taken several things for one: if what is drawn there is really several separate things (by the rules: each object and each living figure its own), reply with one ### NEW section per thing; the first is the one the book knows (with the name, ids and place above), the others get their own names and actor ids and stand where they are drawn.

${draft}`;
        // the build list only while this frame still owns it: a retry minutes later must not bring an old queue back
        const done = (x) => { const k = things.findIndex(t => t?.file === file); if (k >= 0 && thingsOwner === name) thingState(k, 'done'); report.finals.push({ file, at: T(), ...x }); mark('finalsDone'); report.timing.finalsDone = T(); try { save(); } catch { /* a late retry after the reports folder went */ } };
        const failed = x => {
          done({ ...x, attempt });
          // the retry outlives the frame (its folders may be gone by then): it must never throw
          if (attempt === 1) { setTimeout(() => finalOf({ s, file, draft, thingName, ids, draftBox, attempt: 2 }).catch(e => log(`${name}: retry of ${file}: ${e.message.slice(0, 120)}`)), FINAL_RETRY_MS).unref?.(); return; }
          // the second try failed too: the draft stands for good, as a plain thing (only if nothing changed it meanwhile)
          const path = join(thingsDir, file);
          let now = null;
          try { now = readFileSync(path, 'utf8'); } catch { /* removed */ }
          if (now === draft) try { atomicWrite(path, draft.replace(/(export\s+const\s+meta\s*=\s*\{) draft: true,/, '$1')); log(`${name}: final of ${file} failed twice: the draft stays, as a plain thing`); } catch { /* the folder is gone */ }
        };
        try {
          const r = await oneShot({ system: SYSTEM, text, images: s.images || images, model: MODEL });
          report.calls.push(callOf(r, { final: file }));
          const others = [...existing.flatMap(t => t.ids), ...report.written.flatMap(w => w.ids)].filter(i => !ids.includes(i));
          await bookBoxes();
          let secs = [];
          try { secs = parseReply(r.text).filter(x => x.kind === 'NEW'); } catch { /* a bare module */ }
          if (!secs.length) secs = [{ body: stripFences(r.text).replace(/^###.*\n/, '') }];
          const split = secs.length > 1;
          const extra = info => [...sameSpot(draftBox, split)(info), ...hangingLoose(file)(info)];
          let f = await finish({ body: secs[0].body, model: MODEL, frame, images: s.images || images, takenIds: others,
            keepIds: ids, oldName: thingName, calls: report.calls, fixModels: [MODEL], extra });
          if (!f.code) { log(`${name}: final of ${file} failed its checks, the draft stays: ${f.problems.join('; ').slice(0, 200)}`); return failed({ kept: 'draft', problems: f.problems }); }
          // the book knows it by its name (personas, quests, dialogues): the final keeps the draft's
          const finalName = f.code.match(/name:\s*['"]([^'"]+)['"]/)?.[1];
          if (finalName && finalName !== thingName) {
            const q = finalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            f = { ...f, code: f.code.replace(new RegExp(`(name:\\s*)(['"])${q}\\2`, 'g'), (_, a, b) => `${a}${b}${thingName}${b}`) };
          }
          let now = null;
          try { now = readFileSync(path, 'utf8'); } catch { /* removed meanwhile */ }
          if (now !== draft) { log(`${name}: final of ${file} dropped: the thing changed or was removed meanwhile`); return done({ dropped: 'changed meanwhile' }); }
          atomicWrite(path, f.code);
          log(`${name}: FINAL ${file} (${thingName}) by ${MODEL}, ${((Date.now() - settledAt) / 1000).toFixed(1)}s after the frame settled`);
          // the other things the draft had taken for one: written as new things, checked like any
          const parts = [];
          for (const x of secs.slice(1)) {
            if (wordOnly(x.body)) continue;
            // finals outlive the frame: a later frame may have written meanwhile, so names and ids are checked against
            // the things on disk at write time (review of 415f49b)
            const onDisk = readdirSync(thingsDir).filter(f => /^[\w.-]+\.js$/.test(f));
            const diskIds = onDisk.filter(f => f !== file).flatMap(f => { try { return [...readFileSync(join(thingsDir, f), 'utf8').matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(m => m[1]); } catch { return []; } });
            const taken = [...new Set([...others, ...ids, ...report.written.flatMap(w => w.ids), ...diskIds])];
            const g = await finish({ body: x.body, model: MODEL, frame, images: s.images || images, takenIds: taken, keepIds: [], calls: report.calls, fixModels: [MODEL], extra: hangingLoose(null) });
            if (!g.code) { log(`${name}: a part split from ${file} failed its checks: ${g.problems.join('; ').slice(0, 160)}`); continue; }
            // the check took seconds: what is on disk now decides (ids and names a later frame wrote meanwhile)
            const nowOnDisk = readdirSync(thingsDir).filter(f => /^[\w.-]+\.js$/.test(f) && f !== file).map(f => { try { return readFileSync(join(thingsDir, f), 'utf8'); } catch { return ''; } });
            const partIds = [...g.code.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(m => m[1]);
            const idsNow = new Set(nowOnDisk.flatMap(c => [...c.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(m => m[1])));
            if (partIds.some(i => idsNow.has(i))) { log(`${name}: a part split from ${file} not written: its actor id was taken meanwhile`); continue; }
            let partName = g.code.match(/name:\s*['"]([^'"]+)['"]/)?.[1] || 'Ding', code = g.code;
            const names = new Set([...existing.map(t => String(t.meta.name).toLowerCase()), ...report.written.map(w => w.name.toLowerCase()),
              ...nowOnDisk.map(c => c.match(/\bmeta\s*=\s*\{[^}]*?\bname:\s*['"]([^'"]+)['"]/)?.[1]?.toLowerCase()).filter(Boolean)]);
            if (names.has(partName.toLowerCase())) {
              let n = 2;
              while (names.has(`${partName} ${n}`.toLowerCase())) n++;
              const q = partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              code = code.replace(new RegExp(`(name:\\s*)(['"])${q}\\2`, 'g'), (_, a, b) => `${a}${b}${partName} ${n}${b}`);
              partName = `${partName} ${n}`;
            }
            const base = freeName(slug(partName), new Set([...files, ...readdirSync(thingsDir).map(f => f.replace(/\.js$/, ''))]));
            files.add(base);
            const partFile = base + '.js';
            atomicWrite(join(thingsDir, partFile), code);
            const pm = code.match(/paper:\s*\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+)/);
            if (pm) { paper[partFile] = { x: +pm[1], y: +pm[2] }; writePaper(reportsDir, paper); }
            report.written.push({ kind: 'NEW', file: partFile, name: partName, model: MODEL, at: T(), ids: [...code.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(m => m[1]), splitFrom: file });
            parts.push(partFile);
            log(`${name}: SPLIT from ${file}: WROTE ${partFile} (${partName}) by ${MODEL}`);
          }
          done({ model: MODEL, seconds: +r.seconds.toFixed(1), ...(parts.length && { split: parts }) });
          // the watcher refreshes dialogues from what a frame wrote; these came after it returned
          if (parts.length) try { onLater({ written: report.written.filter(w => parts.includes(w.file)) }); } catch { /* never breaks a final */ }
        } catch (e) { log(`${name}: final of ${file} failed, the draft stays: ${e.message.slice(0, 200)}`); failed({ kept: 'draft', problems: [e.message.slice(0, 200)] }); }
      });
    }
    // sections of the main reply: only those it owns (not given to a helper), and no UPDATE on a new sheet
    const take = secs => {
      for (const s of secs) {
        if ((s.kind !== 'NEW' && s.kind !== 'UPDATE') || sent.has(s.n) || claimed.get(s.n) === 'helper') continue;
        sent.add(s.n);
        if (newSheet && s.kind === 'UPDATE') { report.rejected.push({ kind: s.kind, file: s.file, problems: ['a new sheet only adds new things'] }); continue; }
        write(s);
      }
    };
    const completeSections = text => {                        // everything before the last section header
      const heads = [...text.matchAll(/^###\s*(NEW|UPDATE|REMOVE|UNCLEAR)\b/gm)];
      if (heads.length < 2) return [];
      try { return numbered(parseReply(text.slice(0, heads.at(-1).index))); } catch { return []; }
    };

    // A new sheet with many drawings: helpers write some of them in parallel calls, from the end of the
    // SEEN list, while the main call writes from the start. When the main call begins one a helper has
    // taken, everything after it is taken too: the main call stops there. At most HELPERS + 1 writing
    // calls at once, plus up to FIX_SLOTS fix calls.
    const claimed = new Map(), stop = new AbortController(), helpers = [];
    const helper = async () => {
      for (;;) {
        if (halted) return;
        let k = -1;
        for (let i = said.seen.length - 1; i >= said.begun; i--) if (!claimed.has(i)) { k = i; break; }
        if (k < 0) return;
        claimed.set(k, 'helper');
        await buildOne(k, said.seen[k]);
      }
    };
    // one drawing of the sheet, by its own call; checked and written like a section of the main reply.
    // From a list (detectSheet): its box and actor id are known, so it is placed and named without guessing
    let turnedImages = null;                          // the frame turned round, once for all upside-down drawings
    async function buildOne(k, e, { id = null, area = null, others = said.seen.filter((_, i) => i !== k).map(x => x.de) } = {}) {
      let text, seen = images;
      if (area) {
        const px = (area[0] + area[2]) / 2, py = (area[1] + area[3]) / 2, [ix, iz] = islandOf(px, py);
        // a drawing lying upside down (eyes below the mouth) is shown turned round: asked to turn it itself,
        // DeepSeek flipped the mouth into a smile but left the eyes below it. Its place stays the paper's.
        const turned = e.up === 'upside down';
        if (turned) seen = turnedImages ||= images.map(i => execFileSync('convert', ['jpg:-', '-rotate', '180', 'jpg:-'], { input: i, maxBuffer: 20e6 }));
        text = oneOfText({ ask, entry: turned ? { ...e, box: [1 - e.box[2], 1 - e.box[3], 1 - e.box[0], 1 - e.box[1]].map(v => +v.toFixed(3)) } : e,
          others, id, place: [+ix.toFixed(2), +iz.toFixed(2), +px.toFixed(2), +py.toFixed(2)] });
      } else text = `${ask}

Several builders make this sheet at the same time. You build only this one drawing: ${e.de} (${e.en}). The others (${others.join(', ')}) are built by someone else: leave them out, but keep this one's actor id different from theirs. Reply with just its one ### NEW section, no SEEN line.`;
      try {
        // a draft is asked for as an honest sketch; its final (s.prompt below) gets the plain question
        const h = await buildSlot(() => oneShot({ system: SYSTEM, images: seen, text: DRAFT_MODEL ? `${text}\n\n${DRAFT_NOTE}` : text, model: BUILD }));
        report.calls.push(callOf(h, { helper: e.de }));
        const sec = parseReply(h.text).find(x => x.kind === 'NEW');
        if (!sec) { thingState(k, 'failed'); report.rejected.push({ kind: 'NEW', name: e.de, problems: ['the helper wrote no NEW section'] }); return; }
        sec.n = k; sec.images = seen; sec.prompt = text; sent.add(k);
        write(sec);                                  // checked while this helper takes the next one
      } catch (err) { thingState(k, 'failed'); report.rejected.push({ kind: 'NEW', name: e.de, problems: [`helper call failed: ${err.message.slice(0, 200)}`] }); }
    }
    const onText = text => {
      said = narrate(text);
      listThings();
      mark('firstText');
      if (said.seen.length) mark('seen');
      tell({ seen: seenOf(said.seen), now: nowOf(said.seen[said.begun - 1]) });
      for (let k = 0; k < said.begun; k++) if (!claimed.has(k)) claimed.set(k, 'main');
      if ([...claimed].some(([k, who]) => who === 'helper' && k < said.begun)) stop.abort();   // the rest is the helpers'
      if (newSheet && PARALLEL && said.seen.length > 2 && !helpers.length)
        for (let i = 0; i < Math.min(HELPERS, said.seen.length - 1); i++) helpers.push(helper());
      take(completeSections(text));
    };
    // A new sheet: a quick call lists its drawings, then each is built by its own call, all at once (no waiting
    // for one long reply). If the list fails, the one main call (with helpers) below does it as before.
    const listed = newSheet && PARALLEL ? await detectSheet({ images, existing, calls: report.calls }) : null;
    if (newSheet && PARALLEL) mark('listed');
    let sections = [], r = null;
    // the same sheet seen again (moved far, so capture says new sheet): what the list says is in the book already
    // is not built a second time (Sebastian: 6 things doubled at 154727). Only in add mode: switch starts empty.
    if (listed && newSheet === 'add') {
      const again = againInBook(listed, existing);
      if (again.fit) report.sheetFit = again.fit;
      if (again.length) {
        report.alreadyInBook = again.map(e => e.inBook || e.de);
        log(`${name}: ${again.length} of ${listed.length} drawings are in the book already (${report.alreadyInBook.join(', ')}): not built again`);
        listed.splice(0, listed.length, ...listed.filter(e => !again.includes(e)));
      }
    }
    if (listed) {
      said = { seen: listed, begun: listed.length };
      report.said = listed;
      tell({ seen: seenOf(listed), now: null });
      listThings();
      // every actor id is set before any build starts, so each build knows the others' ids too (a branch holds
      // the sloth by its id, a held thing names its holder), and parallel builds never collide
      const taken = new Set(existing.flatMap(t => t.ids));
      const ids = listed.map(e => { const id = freeName(slug(e.de.replace(/^(ein|eine|einen)\s+/i, '')), taken); taken.add(id); return id; });
      listed.forEach((e, k) => helpers.push(buildOne(k, e, { id: ids[k], area: e.box, others: listed.map((x, i) => i === k ? null : `${x.den} (actor id "${ids[i]}" if alive)`).filter(Boolean) })));
    } else {
      try { r = await oneShot({ system: SYSTEM, text: DRAFT_MODEL ? `${ask}\n\n${DRAFT_NOTE}` : ask, images, onText, signal: stop.signal, timeoutMs: 6 * 60_000, model: BUILD }); }
      catch (e) {
        // the main call failed (timeout, limit, login): let what is already being written finish, start nothing
        // new. If something got written, the frame counts as done (a retry would write it twice).
        halted = true;
        await Promise.allSettled(helpers);
        await Promise.allSettled(pending);
        for (const { s, hangs } of waiting.splice(0)) report.rejected.push({ kind: s.kind, file: s.file, problems: [`not written: the main call failed before ${hangs ? 'what it hangs from or sits on' : 'the creature it holds'} was written`] });
        if (!report.written.length) throw e;
        report.mainError = e.message;
        log(`${name}: the main call failed after ${report.written.length} thing(s) were written; not retrying: ${e.message}`);
        return report;
      }
      said = narrate(r.text);
      listThings();
      report.said = said.seen;
      report.calls.push(callOf(r, r.aborted ? { stopped: 'the rest went to helpers' } : {}));
      report.reply = r.text.slice(0, 4000);
      sections = r.aborted ? completeSections(r.text) : numbered(parseReply(r.text));
    }
    take(sections);
    await Promise.all(helpers);
    await Promise.all(pending);
    // hanging creatures first (what holds them, still waiting, counts as above them), then what holds them
    for (const w of [...waiting].sort((a, b) => !!b.hangs - !!a.hangs)) { await write(w.s, true); waiting.splice(waiting.indexOf(w), 1); }
    if (!sections.length && !report.written.length) log(`${name}: nothing new${r ? ` (${r.seconds.toFixed(1)}s)` : ''}`);
    // many removals at once is a new or moved sheet, not a child erasing: remove nothing and say so
    const removes = newSheet ? [] : sections.filter(s => s.kind === 'REMOVE');
    for (const s of newSheet ? sections.filter(s => s.kind === 'REMOVE') : []) report.rejected.push({ kind: s.kind, file: s.file, problems: ['a new sheet only adds new things'] });
    // a big change (new or moved sheet) never removes anything: that is newworld's job, the person decides
    if (removes.length && (bigChange || removes.length > 2)) {
      const why = bigChange ? 'a big change (new or moved sheet): nothing is removed then' : `${removes.length} removals in one frame: a new sheet? not removing`;
      for (const s of removes) report.rejected.push({ kind: s.kind, file: s.file, problems: [why] });
      log(`${name}: ${removes.length} REMOVE(s) refused: ${why}`);
      removes.length = 0;
    }
    for (const s of sections) {
      if (s.kind === 'UNCLEAR') { report.unclear.push(s.body); report.why ||= whyOf(s.body); log(`${name}: UNCLEAR ${s.body}`); continue; }
      if (s.kind === 'REMOVE' && removes.includes(s)) {
        // only with a before picture to compare; the file moves to frames/removed/, so a wrong removal is one mv away from undone
        const t = existing.find(x => x.file === s.file);
        // and only a thing that sits in the area that changed: one confusion (or "REMOVE bana.js" written on
        // the paper) must not take away something drawn elsewhere. Things without meta.paper (hand-made) stay.
        const p = t?.meta.paper, inArea = p && p.x >= area[0] && p.x <= area[2] && p.y >= area[1] && p.y <= area[3];
        const why = !before ? 'no before picture to compare' : !t ? 'no such thing' : !p ? 'it has no meta.paper position: remove it by hand' : p.stale ? 'its paper position is unknown since the sheet moved too far' : !inArea ? `it is at paper ${JSON.stringify(p)}, outside the changed area` : null;
        if (why) { report.rejected.push({ kind: s.kind, file: s.file, problems: [why] }); log(`${name}: REMOVE ${s.file} ignored: ${why}`); continue; }
        const bin = join(dirname(reportsDir), 'removed');
        mkdirSync(bin, { recursive: true });
        renameSync(join(thingsDir, t.file), join(bin, `${name}-${t.file}`));
        delete paper[t.file]; writePaper(reportsDir, paper);
        report.removed.push({ file: t.file, kept: join(bin, `${name}-${t.file}`), why: s.body.slice(0, 200) });
        log(`${name}: REMOVED ${t.file} (erased from the paper; kept as ${join(bin, `${name}-${t.file}`)})`);
      }
    }
    if (render && renders.length) {   // after the writes, off the critical path, one at a time
      (async () => {
        const { renderThing } = await import('./render.mjs');
        report.renders = {};
        for (const { base, file, code } of renders) {
          const dir = mkdtempSync(join(tmpdir(), 'kritzel-render-'));
          try {
            writeFileSync(join(dir, file), code);
            const x = await renderThing(dir, join(reportsDir, `${name}-${base}`), { focus: place.slice(0, 2), height });
            report.renders[file] = x; save();
            if (x.errors.length) log(`${file}: viewer errors: ${x.errors.join('; ')}`);
          } catch (e) { log(`${file}: render failed: ${e.message}`); }
          finally { rmSync(dir, { recursive: true, force: true }); }
        }
      })();
    }
    Object.defineProperty(report, 'finalsDone', { value: Promise.allSettled(finals), enumerable: false });
    return report;
  } catch (e) {
    report.error = e.message;
    log(`${name}: ERROR ${e.message}`);
    return report;
  } finally {
    try { endThings?.(); } catch { /* the list must not break a frame */ }
    report.finished = new Date().toISOString();
    report.timing.done = T();
    save();
  }
}

// a big change that built nothing (the paper taken away: an empty table) keeps the places from before it: they are
// still the sheet's places when it comes back. `before` is the paper map read before movePaperAlong.
// When the list matched it as the same sheet moved (report.sheetFit), the places move by that fit instead: they are
// where the sheet lies now, so REMOVE and UPDATE match against where things really are (review of 68ef9af).
export function keepPlacesIfNothing(reportsDir, before, r) {
  if (r.error || r.written.length || r.removed?.length) return false;
  const now = readPaper(reportsDir);
  if (!Object.entries(now).some(([k, v]) => k !== '_through' && v?.stale && !before[k]?.stale)) return false;
  const f = r.sheetFit, moved = {};
  for (const [k, v] of Object.entries(before)) {
    if (k === '_through' || !f || typeof v?.x !== 'number') { moved[k] = v; continue; }
    moved[k] = { ...v, x: +(f.sr * v.x - f.si * v.y + f.tx).toFixed(3), y: +(f.si * v.x + f.sr * v.y + f.ty).toFixed(3) };
  }
  writePaper(reportsDir, { ...moved, _through: now._through });
  return true;
}

// apply the sheet moves of every frame after paper._through up to `upTo`, in order (things without an
// entry yet start from their meta.paper). The first time, there is no history to replay: start here.
export async function movePaperAlong(dir, upTo, { thingsDir, reportsDir }) {
  const paper = readPaper(reportsDir);
  const frames = readdirSync(dir).filter(f => /^\d{8}-\d{6}\.jpg$/.test(f) && f <= upTo).sort();
  if (!paper._through) { paper._through = frames.at(-2) || upTo; }
  const todo = frames.filter(f => f > paper._through);
  if (!todo.length) return;
  for (const t of await readThings(thingsDir)) if (!paper[t.file] && t.meta.paper) paper[t.file] = t.meta.paper;
  for (const f of todo) {
    let side = {};
    try { side = JSON.parse(readFileSync(join(dir, f.replace('.jpg', '.json')), 'utf8')); } catch {}
    const A = side.affine;
    if (Array.isArray(A) && A.length === 6 && (A[2] || A[5] || A[0] !== 1 || A[4] !== 1 || A[1] || A[3])) {
      for (const k of Object.keys(paper)) if (k !== '_through') paper[k] = { ...paper[k], ...movePaper(paper[k], A, side.width || 1920, side.height || 1080) };   // keeps stale
      log(`${f}: sheet moved by ${A[2]}, ${A[5]} px: paper positions moved along`);
    } else if (A == null && side.reason === 'big-change') {
      // moved too far (or a new sheet) to measure: where things are on the paper is unknown now. Stale
      // positions never satisfy the REMOVE guard; a thing gets a fresh one when it is next written.
      for (const k of Object.keys(paper)) if (k !== '_through' && paper[k]) paper[k] = { ...paper[k], stale: true };
      log(`${f}: big change without a measured move: paper positions marked stale`);
    }
    paper._through = f;
  }
  writePaper(reportsDir, paper);
}

// the dialogue pool was made for another cast (or is missing): a restart during a pool call leaves it so
export async function poolIsStale(thingsDir) { return !!(await staleReason(thingsDir)); }
// why the pool must be made again at start, for the log: null when it is fine
export async function staleReason(thingsDir) {
  const { castOf } = await import('./dialogues.mjs');
  const want = [...new Set(castOf(thingsDir).map(c => c.name))].sort();
  if (want.length < 2) return null;                             // no pool is made for fewer than two
  let have = null;
  try { have = JSON.parse(readFileSync(join(thingsDir, 'dialogues.json'), 'utf8')); } catch { /* missing */ }
  // a pool from before personas (or missing one for a figure) is stale too: else a world whose cast did not
  // change never gets them (live 14:21: no call at all, the 10:31 pool stayed)
  const ids = castOf(thingsDir).map(c => c.id);
  // and one without quests (from before them), or with a quest whose figure or thing has left the book
  const { thingsOf } = await import('./dialogues.mjs');
  const here = new Set([...castOf(thingsDir).flatMap(c => [c.id, c.name]), ...thingsOf(thingsDir).map(t => t.name)].map(x => x.toLowerCase()));
  if (JSON.stringify(have?.cast) !== JSON.stringify(want)) return have ? 'pool for another cast' : 'no pool';
  if (ids.some(id => !have?.personas?.[id])) return 'pool without personas';
  if (ids.some(id => !Array.isArray(have.personas[id].acts))) return 'pool without acts';
  if (!Array.isArray(have?.quests)) return 'pool without quests';
  if (have.quests.some(q => !here.has(String(q?.who).toLowerCase()))) return 'a quest for someone who left';
  return null;
}

// The dialogue pool (and personas) is refreshed in the background, never waited on, within a budget: a change
// (the cast, or the moment in the sim's situation feed) waits POOL_DEBOUNCE for more to come, then one call
// covers them all; at most POOL_PER_HOUR calls in any hour (more wait for the window). Each call is logged
// with its reasons and its count this hour.
const POOL_DEBOUNCE_MS = (+process.env.KRITZEL_POOL_DEBOUNCE_S || 30) * 1000;
const POOL_PER_HOUR = +process.env.KRITZEL_POOL_PER_HOUR || 20;
const SITUATION = join(ROOT, 'frames', 'status', 'situation.json');   // written by the viewer's sim (PUT /api/situation)
const pool = { calls: [], reasons: new Set(), newThings: new Set(), timer: null, busy: false, fellBack: false };
export function wantDialogues(opts, reason, newThings = []) {
  if (!pool.loaded) { pool.loaded = true; loadPoolCalls(opts); }
  pool.reasons.add(reason);
  for (const n of newThings) pool.newThings.add(n);
  if (!pool.timer) { pool.timer = setTimeout(() => runPool(opts), POOL_DEBOUNCE_MS); pool.timer.unref?.(); }
}
// the call times of the last hour, kept in <reports>/pool-calls.json: the cap holds across watcher restarts (live saw
// 49 calls in an hour with restarts in between)
const callsFile = opts => join(opts.reportsDir || join(ROOT, 'frames', 'generated'), 'pool-calls.json');
function loadPoolCalls(opts) {
  try { const a = JSON.parse(readFileSync(callsFile(opts), 'utf8')); if (Array.isArray(a)) pool.calls = a.filter(t => typeof t === 'number' && Date.now() - t < 3600_000).sort((a, b) => a - b); } catch { /* none yet */ }
}
function savePoolCalls(opts) { try { atomicWrite(callsFile(opts), JSON.stringify(pool.calls)); } catch { /* the cap still holds in this run */ } }
function runPool(opts) {
  pool.timer = null;
  const later = ms => { pool.timer = setTimeout(() => runPool(opts), ms); pool.timer.unref?.(); };
  if (pool.busy) return later(5000);
  const now = Date.now();
  while (pool.calls.length && now - pool.calls[0] > 3600_000) pool.calls.shift();
  // while pi fails, the calls go to the fallback on the shared Claude plan: half the cap then
  const cap = pool.fellBack ? Math.max(1, Math.floor(POOL_PER_HOUR / 2)) : POOL_PER_HOUR;
  if (pool.calls.length >= cap) {
    const wait = pool.calls[0] + 3600_000 - now + 1000;
    log(`dialogues: ${cap} calls this hour${pool.fellBack ? ' (half: pi is failing)' : ''}, the next (${[...pool.reasons].join(', ')}) in ${Math.round(wait / 1000)}s`);
    return later(wait);
  }
  const reason = [...pool.reasons].join(', '), newThings = [...pool.newThings];
  pool.reasons.clear(); pool.newThings.clear();
  let situation = null;
  try { situation = JSON.parse(readFileSync(SITUATION, 'utf8')); } catch { /* no feed yet: the cast alone */ }
  pool.busy = true; pool.calls.push(now); savePoolCalls(opts);
  import('./dialogues.mjs').then(m => m.makePool({ thingsDir: opts.thingsDir, reason, situation, newThings }))
    .then(x => {
      if (x.seconds == null) { pool.calls.pop(); savePoolCalls(opts); return log(`dialogues: no call (${x.reason})`); }   // fewer than two figures
      pool.fellBack = !!x.fellBack;
      log(`dialogues: call ${pool.calls.length}/${POOL_PER_HOUR} this hour (${reason}): ${x.written} of ${x.offered} dialogues kept, ${x.personas} new personas, ${x.quests} new quests, ${x.seconds.toFixed(0)}s, ${x.model}${x.fellBack ? ' (pi failed)' : ''}${x.dropped ? `; dropped: ${x.dropped.join('; ')}` : ''}`);
    })
    .catch(e => log(`dialogues: ${e.message}`))
    .finally(() => { pool.busy = false; });
}

// what changed in the sim's moment that the pool can't cover yet: someone starts carrying or throwing a thing,
// night falls or ends, the weather changes. (Putting a thing down or day-to-night jitter is not a reason.)
export function situationChanges(prev, cur) {
  if (!cur) return [];
  const out = [], key = x => `${x.who}:${x.what}`;
  const had = new Set((prev?.carrying || []).map(key));
  for (const c of cur.carrying || []) if (!had.has(key(c))) out.push(`${c.who} carries ${c.what}`);
  const flew = new Set((prev?.thrown || []).map(key));
  for (const t of cur.thrown || []) if (!flew.has(key(t))) out.push(`${t.who} throws ${t.what}`);
  const done = new Set((prev?.solved || []).map(x => `${x?.who}@${x?.at}`));
  for (const x of cur.solved || []) if (typeof x?.who === 'string' && !done.has(`${x.who}@${x.at}`)) out.push(`quest solved: ${x.who.slice(0, 40)}`);
  const dark = x => typeof x?.night === 'number' && x.night >= 0.5;
  if (prev && dark(prev) !== dark(cur)) out.push(dark(cur) ? 'night falls' : 'morning');
  const w = x => [...(x?.weather || [])].sort().join(',');
  if (prev && w(prev) !== w(cur)) out.push(w(cur) ? `weather: ${w(cur)}` : 'the weather clears');
  return out;
}

// 'add' (default: new drawings join the world) or 'switch' (a new sheet starts a new world)
export function modeOf(thingsDir) {
  try { return JSON.parse(readFileSync(join(thingsDir, 'mode.json'), 'utf8')).mode === 'switch' ? 'switch' : 'add'; } catch { return 'add'; }
}

// ---------- watch frames/settled ----------
// Resumes after the newest frame with a finished report in reportsDir, so frames capture wrote
// while generate was down still get made. On a first run ever, the frames already there count as
// what things/ shows. If several frames queued up, only the newest matters (it shows the whole
// sheet); its changed_box is only trusted if it was measured against the frame we last handled.
// A failing frame gets ATTEMPTS tries with backoff, then is marked failed; not logged in waits long.
const ATTEMPTS = 3;
// frames/status/generate.json for the viewer's status pill: { state, since, beat, detail, frame },
// state idle|building|new|changed|unclear|failed; rewritten every 2 s so the viewer knows we run.
// The pill narrates (#18) with: seen [{ de, en }] (indefinite) and now { de, en } (definite accusative)
// while building, made [{ de, en }] (names) on new/changed, why { de, en } on unclear.
function statusFile(file) {
  let st = { state: 'idle', since: Date.now() / 1000, detail: '', frame: '' };
  const write = () => { try { mkdirSync(dirname(file), { recursive: true }); atomicWrite(file, JSON.stringify({ ...st, beat: Date.now() / 1000 })); } catch {} };
  setInterval(write, 2000).unref();
  write();
  const set = (state, frame, detail = '', extra = {}) => { st = { ...(st.things && { things: st.things }), state, since: Date.now() / 1000, detail, frame: frame.replace(/\.jpg$/, ''), ...extra }; write(); };
  set.more = extra => { st = { ...st, ...extra }; write(); };   // same state, more to tell
  return set;
}

async function watch(dir, opts) {
  const status = statusFile(join(ROOT, 'frames', 'status', 'generate.json'));
  const list = () => existsSync(dir) ? readdirSync(dir).filter(f => /^\d{8}-\d{6}\.jpg$/.test(f)).sort() : [];
  const report = f => { try { return JSON.parse(readFileSync(join(opts.reportsDir, f.replace('.jpg', '.json')), 'utf8')); } catch { return null; } };
  const done = f => { const r = report(f); return !!r && !r.error && !r.skipped; };   // generated from, not just skipped
  const frames = list();
  let last = frames.findLast(done) || null;
  if (!last && !readdirSync(opts.reportsDir).some(f => f.endsWith('.json'))) last = frames.at(-1) || null;
  log(`watching ${dir} → ${opts.thingsDir} (${DRAFT_MODEL ? `draft ${DRAFT_MODEL}, final ` : 'model '}${MODEL}${isPiModel(BUILD) ? ` (${BUILD} via pi, ${PI_FALLBACK} when pi fails)` : ''}, fallback ${FALLBACK_MODEL}); handled up to ${last || '(nothing)'}`);
  if (isPiModel(BUILD)) prewarm(BUILD, SYSTEM, 6);            // warm for the first frame: a cold pi costs ~1.3 s, ~140 MB each
  if (isPiModel(DETECT_MODEL)) prewarm(DETECT_MODEL, DETECT_SYSTEM, 1);
  loadPoolCalls(opts);
  if (pool.calls.length) log(`dialogues: ${pool.calls.length} calls in the last hour before this start`);
  const stale = await staleReason(opts.thingsDir).catch(() => null);
  if (stale) { log(`dialogues: ${stale}: making it again`); wantDialogues(opts, `start: ${stale}`); }
  // the sim's moment: read when the file changes (the sim writes it at most every 10 s)
  let situation = null, situationAt = 0;
  const watchSituation = () => {
    let at = 0;
    try { at = statSync(SITUATION).mtimeMs; } catch { return; }
    if (at === situationAt) return;
    situationAt = at;
    let cur = null;
    try { cur = JSON.parse(readFileSync(SITUATION, 'utf8')); } catch { return; }
    const why = situationChanges(situation, cur);
    situation = cur;
    if (why.length) wantDialogues(opts, why.join(', '));
  };
  // the check runs every actor through the book's sim, which needs rot-js (a generate/ dependency)
  try { import.meta.resolve('rot-js'); } catch { log('rot-js is missing (run npm ci in generate/): the check will not run things in the sim'); }
  const sleep = ms => new Promise(ok => setTimeout(ok, ms));
  const later = ({ written }) => wantDialogues(opts, `split: ${written.map(w => w.name).join(', ')}`, written.map(w => w.name));
  let tries = 0, triesFor = null;           // failed attempts, and for which frame
  let archivedFor = null;                   // switch mode: the sheet whose new world is already set up
  // after a failed frame: true = try the same frame again (after a wait), false = give up on it.
  // A frame given up on never counts as generated (lastGenerated stays).
  async function retrySame(error, frame) {
    // claude missing for a moment: Claude Code updates itself in place (the binary is replaced); not counted
    if (/ENOENT/.test(error)) { await sleep(30_000); return true; }
    if (/not logged in|401|authenticat/i.test(error)) { log('claude is not logged in: waiting 10 min'); await sleep(600_000); return true; }
    if (triesFor !== frame) { triesFor = frame; tries = 0; }   // a newer frame starts with a clean count
    if (++tries < ATTEMPTS) { await sleep(20_000 * 2 ** (tries - 1)); return true; }
    log(`${frame}: FAILED after ${ATTEMPTS} attempts, moving on: ${error}`);
    tries = 0;
    return false;
  }
  let lastGenerated = last;                 // the last frame processFrame really ran on (skipped frames don't count)
  // a big change was skipped since lastGenerated: no REMOVEs until a frame is generated (also across a restart)
  let movedSince = frames.some(f => (!lastGenerated || f > lastGenerated) && report(f)?.skipped === 'big-change');
  for (;;) {
    const newest = list().at(-1);
    if (newest && newest !== last) {
      let side = {};
      try { side = JSON.parse(readFileSync(join(dir, newest.replace('.jpg', '.json')), 'utf8')); } catch {}
      // switch mode (things/mode.json, written by the viewer's switch): a new sheet is a new world. Archive
      // the old one (the newworld.sh next to these things) and build everything on the new sheet at once.
      // a new sheet (or one moved too far to follow): capture's own signal, a big change it could not measure as a slide.
      // A big drawing or a slid sheet has a measured affine and is a normal frame.
      const newSheet = side.reason === 'big-change' && side.affine == null;
      if (newSheet && modeOf(opts.thingsDir) === 'switch') {
        // archive once per sheet (even when the build is retried), and only once the sheet yields a thing to build: an
        // empty table after the paper is taken away must not open an empty world (pipeline-capture)
        status('building', newest, 'neue Welt');
        const archive = async () => {
          if (archivedFor === newest) return;
          log(`${newest}: new sheet in switch mode with something to build: archiving the world`);
          const root = resolve(opts.thingsDir, '..', '..');
          try { log(execFileSync(join(root, 'scripts', 'newworld.sh'), [], { cwd: root, encoding: 'utf8' }).trim()); }
          catch (e) { log(`${newest}: newworld.sh failed, no new world: ${e.message}`); throw new Error(`newworld.sh failed: ${e.message.slice(0, 120)}`); }   // the old world stays: nothing is written into it
          archivedFor = newest;
          writePaper(opts.reportsDir, { _through: newest });        // a new world has no old paper positions
        };
        const r = await processFrame(join(dir, newest), { ...opts, onLater: later, box: null, previous: null, newSheet: 'switch', onProgress: status.more, beforeFirstWrite: archive });
        if (r.error) { status('failed', newest, r.error.slice(0, 80)); if (await retrySame(r.error, newest)) continue; last = newest; continue; }
        if (!r.written.length && r.rejected.some(x => /newworld\.sh failed/.test((x.problems || []).join(' ')))) status('failed', newest, 'neue Welt fehlgeschlagen');
        else status(r.written.length ? 'new' : 'unclear', newest, r.written.map(w => w.name).join(', '));
        if (r.written.length) wantDialogues(opts, `new sheet: ${r.written.length} things`, r.written.map(w => w.name));
        else log(`${newest}: nothing written from the new sheet: the world stays`);
        last = lastGenerated = newest; movedSince = false; tries = 0;
        continue;
      }
      // a new sheet in add mode: build what's on it as new things; the world stays, nothing is removed or rewritten
      if (newSheet) {
        log(`${newest}: new sheet (add mode): building what's on it, the world stays`);
        status('building', newest);
        const placesBefore = readPaper(opts.reportsDir);
        await movePaperAlong(dir, newest, opts);
        const r = await processFrame(join(dir, newest), { ...opts, onLater: later, box: null, previous: null, newSheet: 'add' , onProgress: status.more });
        if (keepPlacesIfNothing(opts.reportsDir, placesBefore, r)) log(`${newest}: nothing built: the paper places stay as they were`);
        if (r.error) { status('failed', newest, r.error.slice(0, 80)); if (await retrySame(r.error, newest)) continue; last = newest; continue; }
        status(r.written.length ? 'new' : 'unclear', newest, r.written.map(w => w.name).join(', '));
        if (r.written.length) wantDialogues(opts, `new sheet: ${r.written.length} things`, r.written.map(w => w.name));
        last = lastGenerated = newest; movedSince = false; tries = 0;
        continue;
      }
      // capture's changed_box is only trusted if it was measured against the frame we last generated
      // from; otherwise (frames skipped, a big change in between) the whole sheet is compared with that
      // frame, so a scribble that appeared in a skipped frame is still seen
      const box = side.previous && side.previous === lastGenerated ? side.changed_box : null;
      status('building', newest);
      const placesBefore = readPaper(opts.reportsDir);
      await movePaperAlong(dir, newest, opts);
      const r = await processFrame(join(dir, newest), { ...opts, onLater: later, box, bigChange: movedSince || side.reason === 'big-change', previous: lastGenerated ? join(dir, lastGenerated) : null, onProgress: status.more });
      if (keepPlacesIfNothing(opts.reportsDir, placesBefore, r)) log(`${newest}: nothing built: the paper places stay as they were`);
      const names = r.written.map(w => w.name).join(', ');
      if (r.error) status('failed', newest, r.error.slice(0, 80));
      else if (r.written.length) status(r.written.every(w => w.kind === 'UPDATE') ? 'changed' : 'new', newest, names, { made: r.written.map(w => w.made).filter(Boolean) });
      else status(r.removed.length ? 'changed' : 'unclear', newest, r.removed.length ? 'removed' : '', r.why ? { why: r.why } : {});
      if (!r.error && (r.written.length || r.removed.length))
        wantDialogues(opts, [...r.written.map(w => `${w.kind === 'UPDATE' ? 'changed' : 'new'} ${w.name}`), ...r.removed.map(x => `removed ${x.file}`)].join(', '),
          r.written.filter(w => w.kind === 'NEW').map(w => w.name));
      if (!r.error) { last = lastGenerated = newest; tries = 0; movedSince = false; continue; }
      if (await retrySame(r.error, newest)) continue;
      last = newest;
    }
    watchSituation();
    await sleep(300);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // stop at once on SIGTERM / Ctrl-C: kill running calls and checks (a headless render's browser is
  // closed by playwright on exit). Files are only ever written as .tmp + rename, so nothing is half-written.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    for (const p of live) p.kill('SIGKILL');
    log(`${sig}: stopped`);
    process.exit(sig === 'SIGTERM' ? 143 : 130);
  });
  const args = process.argv.slice(2);
  const flag = n => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
  const opt = (n, def) => { const i = args.indexOf(n); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
  const thingsDir = resolve(opt('--things', join(ROOT, 'viewer', 'things')));
  const reportsDir = resolve(opt('--reports', join(ROOT, 'frames', 'generated')));
  const box = opt('--box', null)?.split(',').map(Number) || null;
  const previous = opt('--previous', null);
  const render = flag('--render');
  mkdirSync(reportsDir, { recursive: true });
  if (args[0] === '--watch') {
    await watch(resolve(args[1] || join(ROOT, 'frames', 'settled')), { thingsDir, reportsDir, render });
  } else if (args[0]) {
    const r = await processFrame(resolve(args[0]), { thingsDir, reportsDir, box, previous: previous && resolve(previous), render });
    await r.finalsDone;                                         // two stages: the finals too
    console.log(JSON.stringify({ written: r.written, removed: r.removed, rejected: r.rejected, unclear: r.unclear, calls: r.calls, error: r.error }, null, 1));
    if (!render) process.exit(r.error ? 1 : 0);
  } else {
    console.error('usage: generate.mjs --watch [frames/settled] [--things DIR] [--reports DIR] [--render]\n       generate.mjs <frame.jpg> [--box x,y,w,h] [--previous before.jpg] [--things DIR] [--reports DIR] [--render]');
    process.exit(2);
  }
}
