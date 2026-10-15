#!/usr/bin/env node
// The generation stage: a settled camera frame → viewer/things/<thing>.js, fast.
//
//   node generate/generate.mjs --watch [frames/settled] [--things DIR] [--reports DIR] [--render]
//   node generate/generate.mjs <frame.jpg> [--box x,y,w,h] [--things DIR] [--reports DIR] [--render]
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { oneShot, MODEL, FALLBACK_MODEL } from './claude.mjs';
import { staticCheck, buildCheck } from './check.mjs';
import { SYSTEM, userText } from './prompts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ---------- existing things: their meta is the registry ----------
async function readThings(dir) {
  const out = [];
  for (const file of readdirSync(dir).filter(f => /^[\w.-]+\.js$/.test(f)).sort()) {
    const code = readFileSync(join(dir, file), 'utf8');
    const ids = [...code.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(x => x[1]);
    const tmp = mkdtempSync(join(tmpdir(), 'kritzel-meta-'));
    try {
      writeFileSync(join(tmp, 'm.mjs'), code);
      const m = await import(pathToFileURL(join(tmp, 'm.mjs')).href);   // top level only; build() is not run
      out.push({ file, meta: { name: file, drawing: '?', ...m.meta }, ids });
    } catch { out.push({ file, meta: { name: file, drawing: '(does not load)' }, ids }); }
    finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  return out;
}

const slug = s => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ding';
function freeName(base, taken) {
  let n = base, i = 2;
  while (taken.has(n)) n = `${base}-${i++}`;
  return n;
}
const atomicWrite = (path, data) => { const tmp = join(dirname(path), '.' + basename(path) + '.tmp'); writeFileSync(tmp, data); renameSync(tmp, path); };

// changed_box (+ margin) → a small JPEG, and where it goes on the island
function cropOf(frame, box) {
  const [W, H] = execFileSync('identify', ['-format', '%w %h', frame], { encoding: 'utf8' }).split(' ').map(Number);
  const [x, y, w, h] = box || [0, 0, W, H];
  const m = Math.max(40, 0.15 * Math.max(w, h));
  const x0 = Math.max(0, Math.round(x - m)), y0 = Math.max(0, Math.round(y - m));
  const x1 = Math.min(W, Math.round(x + w + m)), y1 = Math.min(H, Math.round(y + h + m));
  const image = execFileSync('convert', [frame, '-crop', `${x1 - x0}x${y1 - y0}+${x0}+${y0}`, '+repage', '-resize', '768x768>', '-quality', '85', 'jpg:-'], { maxBuffer: 20e6 });
  const px = (x + w / 2) / W, py = (y + h / 2) / H;           // frame ≈ paper: no paper detection yet
  let ix = (px - 0.5) * 9, iz = (py - 0.5) * 7;               // paper top = island back (-z)
  const r = Math.hypot(ix, iz);
  if (r > 5) { ix *= 5 / r; iz *= 5 / r; }
  const height = box ? +Math.min(3.5, Math.max(0.8, (h / H) * 4.5)).toFixed(1) : 2;
  return { image, place: [+ix.toFixed(2), +iz.toFixed(2), +px.toFixed(2), +py.toFixed(2)], height };
}

const stripFences = t => t.trim().replace(/^```(?:js|javascript)?\s*\n/, '').replace(/\n```\s*$/, '').trim();

// ---------- one settled frame ----------
export async function processFrame(frame, { thingsDir, reportsDir, box = null, render = false }) {
  mkdirSync(reportsDir, { recursive: true });
  const name = basename(frame).replace(/\.\w+$/, '');
  const settledAt = statSync(frame).mtimeMs;
  const report = { frame, box, started: new Date().toISOString(), calls: [], result: null };
  const save = () => writeFileSync(join(reportsDir, name + '.json'), JSON.stringify(report, null, 1));
  try {
    const existing = await readThings(thingsDir);
    const { image, place, height } = cropOf(frame, box);
    const takenIds = existing.flatMap(t => t.ids);
    const files = new Set(existing.map(t => t.file.replace(/\.js$/, '')));
    let problems = null, previousCode = null;
    for (const model of [MODEL, MODEL, FALLBACK_MODEL]) {
      const r = await oneShot({ system: SYSTEM, text: userText({ existing, place, height, takenIds, problems, previousCode }), image, model });
      const reply = stripFences(r.text);
      const call = { model, seconds: +r.seconds.toFixed(1), cost: r.cost, reply: reply.slice(0, 300) };
      report.calls.push(call);
      if (/^NOTHING\b/.test(reply)) { report.result = { nothing: true }; log(`${name}: nothing new (${call.seconds}s, ${model})`); return report; }
      if (/^UNCLEAR\b/.test(reply)) { report.result = { unclear: reply.replace(/^UNCLEAR:?\s*/, '') }; log(`${name}: UNCLEAR ${report.result.unclear} (${call.seconds}s, ${model})`); return report; }

      const code = `// generated by generate/ from frames/settled/${basename(frame)} (${model})\n${reply}\n`;
      problems = staticCheck(code);
      if (!problems.length) problems = (await buildCheck(code, { takenIds })).problems;
      call.problems = problems;
      if (problems.length) { log(`${name}: ${model} module rejected (${call.seconds}s): ${problems.join('; ')}`); previousCode = reply; continue; }

      const thingName = reply.match(/name:\s*['"]([^'"]+)['"]/)?.[1] || 'Ding';
      const base = freeName(slug(thingName), files), file = base + '.js';
      atomicWrite(join(thingsDir, file), code);
      const latency = +((Date.now() - settledAt) / 1000).toFixed(1);
      report.result = { written: file, name: thingName, model, latency };
      log(`${name}: WROTE ${file} (${thingName}) by ${model}, ${latency}s after the frame settled`);
      if (render) {              // after the write, off the critical path
        const { renderThing } = await import('./render.mjs');
        const dir = mkdtempSync(join(tmpdir(), 'kritzel-render-'));
        writeFileSync(join(dir, file), code);
        renderThing(dir, join(reportsDir, `${name}-${base}`), { focus: place.slice(0, 2), height })
          .then(x => { report.render = x; save(); if (x.errors.length) log(`${file}: viewer errors: ${x.errors.join('; ')}`); })
          .catch(e => log(`${file}: render failed: ${e.message}`))
          .finally(() => rmSync(dir, { recursive: true, force: true }));
      }
      return report;
    }
    report.result = { rejected: problems };
    log(`${name}: REJECTED, no module passed the checks: ${problems.join('; ')}`);
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

// ---------- watch frames/settled ----------
// Frames already there at start are what things/ already shows: they are not generated again.
// If several frames queued up while we worked, the newest shows the whole sheet; its changed_box
// is only trusted if it was measured against the frame we last handled.
async function watch(dir, opts) {
  const list = () => existsSync(dir) ? readdirSync(dir).filter(f => /^\d{8}-\d{6}\.jpg$/.test(f)).sort() : [];
  let last = list().at(-1) || null;
  log(`watching ${dir} → ${opts.thingsDir} (model ${MODEL}, fallback ${FALLBACK_MODEL})${last ? `; ${last} counts as done` : ''}`);
  for (;;) {
    const newest = list().at(-1);
    if (newest && newest !== last) {
      let side = {};
      try { side = JSON.parse(readFileSync(join(dir, newest.replace('.jpg', '.json')), 'utf8')); } catch {}
      if (side.reason === 'big-change' && (side.changed ?? 1) > 0.5) {
        log(`${newest}: big change (new sheet or moved paper?): nothing generated; archiving the old world is scripts/newworld.sh's call`);
        writeFileSync(join(opts.reportsDir, newest.replace('.jpg', '.json')), JSON.stringify({ frame: newest, skipped: 'big-change', side }, null, 1));
        last = newest;
        continue;
      }
      const box = side.previous && side.previous === last ? side.changed_box : null;
      const r = await processFrame(join(dir, newest), { ...opts, box });
      if (r.error) { await new Promise(ok => setTimeout(ok, 20_000)); continue; }   // e.g. claude unreachable: retry
      last = newest;
    }
    await new Promise(ok => setTimeout(ok, 300));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = n => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
  const opt = (n, def) => { const i = args.indexOf(n); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
  const thingsDir = resolve(opt('--things', join(ROOT, 'viewer', 'things')));
  const reportsDir = resolve(opt('--reports', join(ROOT, 'frames', 'generated')));
  const box = opt('--box', null)?.split(',').map(Number) || null;
  const render = flag('--render');
  mkdirSync(reportsDir, { recursive: true });
  if (args[0] === '--watch') {
    await watch(resolve(args[1] || join(ROOT, 'frames', 'settled')), { thingsDir, reportsDir, render });
  } else if (args[0]) {
    const r = await processFrame(resolve(args[0]), { thingsDir, reportsDir, box, render });
    console.log(JSON.stringify({ result: r.result, calls: r.calls, error: r.error }, null, 1));
    if (!render) process.exit(r.error ? 1 : 0);
  } else {
    console.error('usage: generate.mjs --watch [frames/settled] [--things DIR] [--reports DIR] [--render]\n       generate.mjs <frame.jpg> [--box x,y,w,h] [--things DIR] [--reports DIR] [--render]');
    process.exit(2);
  }
}
