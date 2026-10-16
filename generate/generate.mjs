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
// Every frame leaves <reports>/<frame>.json: the reply, checks, timings, cost. --render also
// renders each written thing in the real viewer (headless) to <reports>/<frame>-<thing>-front.png.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneShot, MODEL, FALLBACK_MODEL } from './claude.mjs';
import { live } from './children.mjs';
import { staticCheck, buildCheck, metaOf } from './check.mjs';
import { SYSTEM, userText, fixText } from './prompts.mjs';
import { islandOf, movePaper } from './place.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

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
  const crop = (f, size = box ? '768x768>' : '1568x1568>') => execFileSync('convert', [f, '-crop', `${x1 - x0}x${y1 - y0}+${x0}+${y0}`, '+repage', '-resize', size, '-quality', '85', 'jpg:-'], { maxBuffer: 20e6 });
  const image = crop(frame), before = previous && existsSync(previous) ? crop(previous) : null;
  const px = (x + w / 2) / W, py = (y + h / 2) / H;           // frame ≈ paper: no paper detection yet
  const [ix, iz] = islandOf(px, py);
  const height = box ? +Math.min(3.5, Math.max(0.8, (h / H) * 4.5)).toFixed(1) : 2;
  const area = [x0 / W, y0 / H, x1 / W, y1 / H];                // the crop, as paper fractions
  // the child's own strokes, for the viewer to texture the thing with (studio-look): the same area, sharper
  const strokes = () => crop(frame, '1024x1024>');
  return { image, before, area, strokes, place: [+ix.toFixed(2), +iz.toFixed(2), +px.toFixed(2), +py.toFixed(2)], height };
}

const stripFences = t => t.trim().replace(/^```(?:js|javascript)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
const MARK = '// generated by generate/ from ';

// "### NEW", "### UPDATE file.js", "### REMOVE file.js", "### UNCLEAR" sections → [{ kind, file, body }]
export function parseReply(text) {
  const t = text.trim();
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

// one module: check it; on failure ask for a fix (same model, then the fallback). → { code, model } | { problems }
async function finish({ body, model, frame, images, takenIds, keepIds, oldName = null, calls }) {
  let code = body.split('\n').filter(l => !l.startsWith(MARK)).join('\n').trim(), problems;
  for (const fixModel of [null, MODEL, FALLBACK_MODEL]) {
    if (fixModel) {
      const r = await oneShot({ system: SYSTEM, text: fixText({ problems, code }), images: images.slice(-1), model: fixModel });   // the area now
      calls.push({ model: fixModel, seconds: +r.seconds.toFixed(1), cost: r.cost, fix: true, fixing: problems });
      code = stripFences(r.text).replace(/^###.*\n/, '');
      model = fixModel;
    }
    const full = `${MARK}frames/settled/${basename(frame)} (${model})\n${code}\n`;
    problems = staticCheck(full);
    if (!problems.length) {
      const b = await buildCheck(full, { takenIds });
      problems = b.problems;
      // a module from before the one-figure rule may hold several figures: updating it is not splitting it
      if (keepIds.length > 1) problems = problems.filter(p => !/actors in one module/.test(p));
      // an updated thing keeps its actor ids (the sim remembers friendships), unless it was renamed into
      // something else that is no longer alive (figures → "Kerzen")
      const renamed = oldName && code.match(/name:\s*['"]([^'"]+)['"]/)?.[1] !== oldName;
      if (!(renamed && !b.info.actors?.length)) for (const id of keepIds) if (!b.info.actors?.includes(id)) problems.push(`keep the actor id "${id}" (the sim remembers its friendships)`);
    }
    if (!problems.length) return { code: full, model, warnings: /^\/\/ parts:/m.test(code) ? [] : ['no // parts: list (a thinking aid for the model; module accepted)'] };
  }
  return { problems };
}

// ---------- one settled frame ----------
export async function processFrame(frame, { thingsDir, reportsDir, box = null, previous = null, bigChange = false, render = false, newSheet = false }) {
  mkdirSync(reportsDir, { recursive: true });
  const name = basename(frame).replace(/\.\w+$/, '');
  const settledAt = statSync(frame).mtimeMs;
  const report = { frame, box, previous, started: new Date().toISOString(), calls: [], written: [], removed: [], rejected: [], unclear: [] };
  const save = () => writeFileSync(join(reportsDir, name + '.json'), JSON.stringify(report, null, 1));
  try {
    const paper = readPaper(reportsDir);
    const existing = await readThings(thingsDir, paper);
    const { image, before, area, strokes, place, height } = cropOf(frame, box, previous);
    let texture = null;                                          // made once, only if something is written
    const images = before ? [before, image] : [image];
    const files = new Set(existing.map(t => t.file.replace(/\.js$/, '')));
    const r = await oneShot({ system: SYSTEM, text: userText({ existing, place, height, takenIds: existing.flatMap(t => t.ids), hasBefore: !!before, newSheet }), images });
    report.calls.push({ model: r.model, seconds: +r.seconds.toFixed(1), cost: r.cost });
    report.reply = r.text.slice(0, 4000);
    const sections = parseReply(r.text);
    if (!sections.length) log(`${name}: nothing new (${r.seconds.toFixed(1)}s)`);
    if (newSheet) {      // a new sheet only brings new things: nothing on the old island is rewritten or removed from it
      for (const x of sections.filter(x => x.kind === 'UPDATE' || x.kind === 'REMOVE')) report.rejected.push({ kind: x.kind, file: x.file, problems: ['a new sheet only adds new things'] });
      sections.splice(0, sections.length, ...sections.filter(x => x.kind === 'NEW' || x.kind === 'UNCLEAR'));
    }
    const renders = [];
    // many removals at once is a new or moved sheet, not a child erasing: remove nothing and say so
    const removes = sections.filter(s => s.kind === 'REMOVE');
    // a big change (new or moved sheet) never removes anything: that is newworld's job, the person decides
    if (removes.length && (bigChange || removes.length > 2)) {
      const why = bigChange ? 'a big change (new or moved sheet): nothing is removed then' : `${removes.length} removals in one frame: a new sheet? not removing`;
      for (const s of removes) report.rejected.push({ kind: s.kind, file: s.file, problems: [why] });
      log(`${name}: ${removes.length} REMOVE(s) refused: ${why}`);
      sections.splice(0, sections.length, ...sections.filter(s => s.kind !== 'REMOVE'));
    }
    for (const s of sections) {
      if (s.kind === 'UNCLEAR') { report.unclear.push(s.body); log(`${name}: UNCLEAR ${s.body}`); continue; }
      if (s.kind === 'REMOVE') {
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
        for (const ext of ['.crop.jpg', '.crop.json']) {          // its strokes go along with it
          const c = t.file.replace(/\.js$/, ext);
          if (existsSync(join(thingsDir, c))) renameSync(join(thingsDir, c), join(bin, `${name}-${c}`));
        }
        delete paper[t.file]; writePaper(reportsDir, paper);
        report.removed.push({ file: t.file, kept: join(bin, `${name}-${t.file}`), why: s.body.slice(0, 200) });
        log(`${name}: REMOVED ${t.file} (erased from the paper; kept as ${join(bin, `${name}-${t.file}`)})`);
        continue;
      }
      const old = s.kind === 'UPDATE' ? existing.find(t => t.file === s.file) : null;
      if (s.kind === 'UPDATE' && !old) { report.rejected.push({ kind: s.kind, file: s.file, problems: ['no such thing to update'] }); log(`${name}: UPDATE of unknown ${s.file} ignored`); continue; }
      // ids of every other thing, including ones written earlier in this reply
      const takenIds = [...existing.filter(t => t !== old).flatMap(t => t.ids), ...report.written.flatMap(w => w.ids)];
      const f = await finish({ body: s.body, model: r.model, frame, images, takenIds, keepIds: old?.ids || [], oldName: old?.meta.name || null, calls: report.calls });
      const thingName = (f.code || s.body).match(/name:\s*['"]([^'"]+)['"]/)?.[1] || 'Ding';
      if (!f.code) { report.rejected.push({ kind: s.kind, file: s.file, name: thingName, problems: f.problems }); log(`${name}: REJECTED ${s.kind} ${s.file || thingName}: ${f.problems.join('; ')}`); continue; }
      const base = old ? old.file.replace(/\.js$/, '') : freeName(slug(thingName), files);
      files.add(base);
      const file = base + '.js';
      const pm = f.code.match(/paper:\s*\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+)/);
      // <base>.crop.jpg + <base>.crop.json { area: paper fractions of the crop, paper: the thing's centre }
      // next to the module, before it, so the viewer finds them when it loads the thing
      try {
        texture ||= strokes();
        atomicWrite(join(thingsDir, base + '.crop.jpg'), texture);
        atomicWrite(join(thingsDir, base + '.crop.json'), JSON.stringify({ area: area.map(v => +v.toFixed(4)), ...(pm && { paper: { x: +pm[1], y: +pm[2] } }) }));
      } catch (e) { log(`${file}: no crop written: ${e.message}`); }
      atomicWrite(join(thingsDir, file), f.code);
      if (pm) { paper[file] = { x: +pm[1], y: +pm[2] }; writePaper(reportsDir, paper); }
      const latency = +((Date.now() - settledAt) / 1000).toFixed(1);
      const ids = [...f.code.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(x => x[1]);
      report.written.push({ kind: s.kind, file, name: thingName, model: f.model, latency, ids, ...(f.warnings.length && { warnings: f.warnings }) });
      log(`${name}: ${s.kind === 'UPDATE' ? 'UPDATED' : 'WROTE'} ${file} (${thingName}) by ${f.model}, ${latency}s after the frame settled`);
      renders.push({ base, file, code: f.code });
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
    return report;
  } catch (e) {
    report.error = e.message;
    log(`${name}: ERROR ${e.message}`);
    return report;
  } finally {
    report.finished = new Date().toISOString();
    save();
  }
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

// the cast changed: refresh the pool of generated dialogues in the background (never waited on);
// if it changes again meanwhile, one more round follows
let poolBusy = false, poolAgain = false;
function refreshDialogues(opts) {
  if (poolBusy) { poolAgain = true; return; }
  poolBusy = true;
  import('./dialogues.mjs').then(m => m.makePool({ thingsDir: opts.thingsDir }))
    .then(x => log(`dialogues: ${x.written} for the new cast${x.seconds ? ` (${x.seconds.toFixed(0)}s, ${x.model})` : ''}`))
    .catch(e => log(`dialogues: ${e.message}`))
    .finally(() => { poolBusy = false; if (poolAgain) { poolAgain = false; refreshDialogues(opts); } });
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
// state idle|building|new|changed|unclear|failed; rewritten every 2 s so the viewer knows we run
function statusFile(file) {
  let st = { state: 'idle', since: Date.now() / 1000, detail: '', frame: '' };
  const write = () => { try { mkdirSync(dirname(file), { recursive: true }); atomicWrite(file, JSON.stringify({ ...st, beat: Date.now() / 1000 })); } catch {} };
  setInterval(write, 2000).unref();
  write();
  return (state, frame, detail = '') => { st = { state, since: Date.now() / 1000, detail, frame: frame.replace(/\.jpg$/, '') }; write(); };
}

async function watch(dir, opts) {
  const status = statusFile(join(ROOT, 'frames', 'status', 'generate.json'));
  const list = () => existsSync(dir) ? readdirSync(dir).filter(f => /^\d{8}-\d{6}\.jpg$/.test(f)).sort() : [];
  const report = f => { try { return JSON.parse(readFileSync(join(opts.reportsDir, f.replace('.jpg', '.json')), 'utf8')); } catch { return null; } };
  const done = f => { const r = report(f); return !!r && !r.error && !r.skipped; };   // generated from, not just skipped
  const frames = list();
  let last = frames.findLast(done) || null;
  if (!last && !readdirSync(opts.reportsDir).some(f => f.endsWith('.json'))) last = frames.at(-1) || null;
  log(`watching ${dir} → ${opts.thingsDir} (model ${MODEL}, fallback ${FALLBACK_MODEL}); handled up to ${last || '(nothing)'}`);
  const sleep = ms => new Promise(ok => setTimeout(ok, ms));
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
        // archive once per sheet, even when the build has to be retried
        if (archivedFor !== newest) {
          log(`${newest}: new sheet in switch mode: archiving the world, building the whole sheet`);
          status('building', newest, 'neue Welt');
          const root = resolve(opts.thingsDir, '..', '..');
          try { log(execFileSync(join(root, 'scripts', 'newworld.sh'), [], { cwd: root, encoding: 'utf8' }).trim()); }
          catch (e) {                 // the old world is still there: don't build a new one into it
            log(`${newest}: newworld.sh failed, no new world: ${e.message}`);
            status('failed', newest, 'neue Welt fehlgeschlagen');
            last = newest; tries = 0;
            continue;
          }
          archivedFor = newest;
          writePaper(opts.reportsDir, { _through: newest });        // a new world has no old paper positions
        }
        const r = await processFrame(join(dir, newest), { ...opts, box: null, previous: null, newSheet: 'switch' });
        if (r.error) { status('failed', newest, r.error.slice(0, 80)); if (await retrySame(r.error, newest)) continue; last = newest; continue; }
        status(r.written.length ? 'new' : 'unclear', newest, r.written.map(w => w.name).join(', '));
        last = lastGenerated = newest; movedSince = false; tries = 0;
        continue;
      }
      // a new sheet in add mode: build what's on it as new things; the world stays, nothing is removed or rewritten
      if (newSheet) {
        log(`${newest}: new sheet (add mode): building what's on it, the world stays`);
        status('building', newest);
        await movePaperAlong(dir, newest, opts);
        const r = await processFrame(join(dir, newest), { ...opts, box: null, previous: null, newSheet: 'add' });
        if (r.error) { status('failed', newest, r.error.slice(0, 80)); if (await retrySame(r.error, newest)) continue; last = newest; continue; }
        status(r.written.length ? 'new' : 'unclear', newest, r.written.map(w => w.name).join(', '));
        last = lastGenerated = newest; movedSince = false; tries = 0;
        continue;
      }
      // capture's changed_box is only trusted if it was measured against the frame we last generated
      // from; otherwise (frames skipped, a big change in between) the whole sheet is compared with that
      // frame, so a scribble that appeared in a skipped frame is still seen
      const box = side.previous && side.previous === lastGenerated ? side.changed_box : null;
      status('building', newest);
      await movePaperAlong(dir, newest, opts);
      const r = await processFrame(join(dir, newest), { ...opts, box, bigChange: movedSince || side.reason === 'big-change', previous: lastGenerated ? join(dir, lastGenerated) : null });
      const names = r.written.map(w => w.name).join(', ');
      if (r.error) status('failed', newest, r.error.slice(0, 80));
      else if (r.written.length) status(r.written.every(w => w.kind === 'UPDATE') ? 'changed' : 'new', newest, names);
      else status(r.removed.length ? 'changed' : 'unclear', newest, r.removed.length ? 'removed' : '');
      if (!r.error && (r.written.length || r.removed.length)) refreshDialogues(opts);
      if (!r.error) { last = lastGenerated = newest; tries = 0; movedSince = false; continue; }
      if (await retrySame(r.error, newest)) continue;
      last = newest;
    }
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
    console.log(JSON.stringify({ written: r.written, removed: r.removed, rejected: r.rejected, unclear: r.unclear, calls: r.calls, error: r.error }, null, 1));
    if (!render) process.exit(r.error ? 1 : 0);
  } else {
    console.error('usage: generate.mjs --watch [frames/settled] [--things DIR] [--reports DIR] [--render]\n       generate.mjs <frame.jpg> [--box x,y,w,h] [--previous before.jpg] [--things DIR] [--reports DIR] [--render]');
    process.exit(2);
  }
}
