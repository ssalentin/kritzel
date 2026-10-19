// Runs one things/*.js module for real, in a child process that check.mjs starts sandboxed:
// no network (own network namespace), node --permission (no fs writes, no child processes,
// no workers, reads only three, viewer/ and the module), killed after a few seconds.
//   node check-run.mjs meta  <module.mjs>                 → {"meta": {...}}
//   node check-run.mjs build <module.mjs> <takenIdsJSON>  → {"problems": [...], "info": {...}}
// The module runs in this process, so a hostile one could fake this output. That is why the
// sandbox, not this result, is what protects the host.
import * as THREE from 'three';
import { footprintOf, isPortable } from '../viewer/portable.js';     // the viewer's own carry rule (GitHub #25)
import { BASE } from '../viewer/book.js';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

// the viewer's sim imports 'rot-js' (an importmap in the page): here it is generate/'s own copy
registerHooks({ resolve: (spec, ctx, next) => next(spec, spec === 'rot-js' ? { ...ctx, parentURL: import.meta.url } : ctx) });

const VIEWER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'viewer');
// the world is an open pop-up book: two pages, x -9..9 (spine at x = 0), z -6.5..6.5, ground y = 0 (= BOOK in place.mjs)
const PAGE_X = 9, PAGE_Z = 6.5;
// the share of a geometry's triangle area that faces inward (its normal against the direction from its centre); a
// flat geometry (thinnest side under 5% of the longest) counts as 0, and triangles nearly side-on are not counted
function inwardShare(geo) {
  const pos = geo.attributes?.position, idx = geo.index;
  if (!pos) return 0;
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3()), dims = [size.x, size.y, size.z].sort((p, q) => p - q);
  if (dims[0] < 0.05 * dims[2]) return 0;
  const c = geo.boundingBox.getCenter(new THREE.Vector3()), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  const tris = idx ? idx.count / 3 : pos.count / 3;
  let inward = 0, counted = 0;
  for (let t = 0; t < tris; t++) {
    const [i, j, k] = idx ? [idx.getX(3 * t), idx.getX(3 * t + 1), idx.getX(3 * t + 2)] : [3 * t, 3 * t + 1, 3 * t + 2];
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, j); d.fromBufferAttribute(pos, k);
    n.subVectors(b, a).cross(m.subVectors(d, a));
    const area = n.length();
    m.copy(a).add(b).add(d).divideScalar(3).sub(c);
    if (!area || !m.lengthSq()) continue;
    const cos = n.dot(m) / (area * m.length());
    if (Math.abs(cos) < 0.2) continue;                     // side-on to the centre: says nothing
    counted += area; if (cos < 0) inward += area;
  }
  return counted ? inward / counted : 0;
}

// The book's real sim moves one actor a while and plays every animation state on it. Returns what it
// throws ({ error }), if anything: in the book, one rig that throws there stops every figure after it.
async function simThrows(actor) {
  globalThis.document ??= { documentElement: {} };            // i18n.js sets the page's language
  let create;
  try { ({ create } = await import(pathToFileURL(join(VIEWER, 'sim.js')).href)); }
  catch (e) { return { skipped: e.message }; }                 // no rot-js here (npm ci in generate/): not checked
  try {
    const b = create({ THREE, actors: [actor], trees: [], pond: { x: 0, z: 0, r: 0 }, spots: [], islandR: 6.5,
      ground: { shape: 'rect', w: 2 * PAGE_X, d: 2 * PAGE_Z }, seed: 1 });
    let t = 0;
    const run = n => { for (let i = 0; i < n; i++) { t += 0.1; b.update(t, 0.1, {}); } };
    run(30);
    for (const s of STATES) { actor.anim = s; actor.animStart = t; actor.animUntil = t + 1; run(3); }
    const [f] = b.failures();                                 // the sim skips a figure that throws; that is a failed rig too
    return f ? { error: f.message } : null;
  } catch (e) { return { error: e.message }; }
}

const STATES = ['idle', 'walk', 'talk', 'wave', 'dance', 'sit', 'scared', 'highfive', 'lookup', 'yawn', 'stretch'];
const out = process.stdout.write.bind(process.stdout);   // taken before the module can replace it

// The same ctx world.js builds, minus the browser parts (speech bubbles, sound are stubs).
async function makeCtx() {
  const world = new THREE.Group();
  const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, flatShading: true, ...opts });
  const limb = (len, r, m) => {         // as world.js: two segments with an elbow/knee joint
    const pivot = new THREE.Group(), elbow = new THREE.Group();
    const seg = () => { const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len / 2 - 2 * r, 6, 12), m); mesh.position.y = -len / 4; return mesh; };
    elbow.position.y = -len / 2;
    pivot.add(seg(), elbow); elbow.add(seg());
    pivot.elbow = elbow;
    return pivot;
  };
  const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
  const bubble = () => ({ say() {} });
  const shadowAll = o => o.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  const { makeCharacters } = await import(pathToFileURL(join(VIEWER, 'characters.js')).href);
  const { makePerson } = makeCharacters({ THREE, world, mat, limb, bubble, shadowAll });
  const env = { cover: 0, actors: [] };
  // ctx.water without a browser (no canvas textures here): same calls, plain shapes of the same size
  const blue = mat(0x5fb4e3, { transparent: true, opacity: 0.85 });
  const v3 = p => new THREE.Vector3(p[0], p.length > 2 ? p[1] : 0.04, p.length > 2 ? p[2] : p[1]);
  const waterUse = { calls: 0, problems: new Set() };
  const limit = (v, hi, what) => { if (v > hi) waterUse.problems.add(`${what} ${v} is over the limit ${hi}; it gets clamped`); };
  const water = {
    pond(x, z, r = 1.2) {
      waterUse.calls++; limit(r, 4, 'ctx.water.pond r'); const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.05, 24), blue); m.position.set(x, 0.03, z); return m; },
    waterfall(from, to, width = 0.6) {
      waterUse.calls++; limit(width, 3, 'ctx.water.waterfall width');
      const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
      const m = new THREE.Mesh(new THREE.BoxGeometry(width, Math.max(0.05, a.y - b.y), Math.max(0.05, Math.hypot(a.x - b.x, a.z - b.z))), blue);
      m.position.copy(a).lerp(b, 0.5); m.lookAt(b.x, m.position.y, b.z); return m;
    },
    river(points, width = 0.7) {
      waterUse.calls++; limit(width, 3, 'ctx.water.river width'); limit(points.length, 32, 'ctx.water.river points');
      const g = new THREE.Group(), pts = points.map(v3);
      for (let i = 1; i < pts.length; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(width, 0.05, pts[i].distanceTo(pts[i - 1])), blue);
        m.position.copy(pts[i]).lerp(pts[i - 1], 0.5); m.lookAt(pts[i]); g.add(m);
      }
      return g;
    },
  };
  return { THREE, world, bubble, shadowAll, mat, limb, rand, makePerson, water, waterUse, pond: { x: 0, z: 0, r: 0 }, trees: [],
    SUN_POS: new THREE.Vector3(2.5, 6.8, -6.5), islandR: 6.5, ground: { shape: 'rect', w: 2 * PAGE_X, d: 2 * PAGE_Z }, env, sound: { fx() {} } };
}

const num = v => typeof v === 'number' && Number.isFinite(v);

// Runs build(ctx) for real in Node and checks what it produced.
// takenIds: actor ids other things already use. Returns { problems, info }.
async function buildCheck(file, takenIds) {
  const problems = [], info = {};
  {
    let m;
    try { m = await import(pathToFileURL(file).href); } catch (e) { return { problems: [`does not load: ${e.message}`], info }; }
    if (!m.meta?.name || !m.meta?.drawing) problems.push('meta needs a name and a drawing description');
    const ctx = await makeCtx();
    let r;
    try { r = (await m.build(ctx)) || {}; } catch (e) { return { problems: [...problems, `build(ctx) throws: ${e.message}`], info }; }
    info.waterCalls = ctx.waterUse.calls;               // drawn water must be the engine's (generate: plainWater)
    if (ctx.waterUse.calls > 6) problems.push(`${ctx.waterUse.calls} ctx.water pieces: at most 6 per thing (the rest are left out); join them into fewer, longer pieces`);
    problems.push(...ctx.waterUse.problems);

    const box = new THREE.Box3().setFromObject(ctx.world);
    let meshes = 0;
    const geoms = {};                                    // geometry types, for the blob check (all spheres and boxes?)
    let tris = 0;                                        // what the viewer draws: tubes, lathes and bevels cost far more than spheres
    ctx.world.traverse(o => { if (o.isMesh) { meshes++; const t = o.geometry?.type || '?'; geoms[t] = (geoms[t] || 0) + 1;
      const gm = o.geometry; tris += gm ? Math.round((gm.index ? gm.index.count : gm.attributes?.position?.count || 0) / 3) : 0; } });
    info.meshes = meshes;
    info.tris = tris;
    info.geoms = geoms;
    if (!meshes) problems.push('build() added nothing visible to ctx.world');
    else {
      info.box = { min: box.min.toArray().map(v => +v.toFixed(2)), max: box.max.toArray().map(v => +v.toFixed(2)) };
      if (Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) > PAGE_X || Math.max(Math.abs(box.min.z), Math.abs(box.max.z)) > PAGE_Z)
        problems.push(`stands off the pages (x ${box.min.x.toFixed(1)}..${box.max.x.toFixed(1)}, z ${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)}); the open book is x -${PAGE_X}..${PAGE_X}, z -${PAGE_Z}..${PAGE_Z}`);
      if (box.min.y < -0.6) problems.push(`sinks into the ground (lowest point y=${box.min.y.toFixed(2)})`);
      if (box.max.y - box.min.y > 7) problems.push(`is ${(box.max.y - box.min.y).toFixed(1)} tall; a person is ~2.2`);
      if (box.max.y - box.min.y < 0.1) problems.push('is flat (under 0.1 tall)');
    }

    const actors = r.actors || [], obstacles = r.obstacles || [], spots = r.spots || [];
    for (const [name, arr] of [['actors', actors], ['obstacles', obstacles], ['spots', spots]])
      if (!Array.isArray(arr)) problems.push(`${name} must be an array`);
    info.actors = actors.map(a => a?.id);
    // every living figure is its own thing, so each can arrive, move and be erased on its own
    if (actors.length > 1) problems.push(`${actors.length} actors in one module: make each living figure its own NEW thing (one actor each), and the scenery a separate thing`);
    // two characters of one thing need their own names: they talk to and about each other
    const names = actors.map(a => a?.name).filter(Boolean);
    if (new Set(names).size < names.length) problems.push(`two actors share a name (${names.join(', ')}): give each its own (e.g. "Große Kerze", "Kleine Kerze")`);
    const ids = new Set(takenIds);
    for (const a of actors) {
      if (!a?.id || typeof a.id !== 'string') { problems.push('an actor has no string id'); continue; }
      if (ids.has(a.id)) problems.push(`actor id "${a.id}" is already taken`);
      ids.add(a.id);
      if (!a.rig?.g?.isObject3D) problems.push(`actor ${a.id}: rig.g must be its THREE.Group`);
      else { let inWorld = false; a.rig.g.traverseAncestors(p => { if (p === ctx.world) inWorld = true; }); if (!inWorld) problems.push(`actor ${a.id}: rig.g is not in ctx.world`); }
      // the rig is only the body: a long straight pole or branch in it walks around with the creature
      if (a.rig?.g?.isObject3D) {
        const pole = [];
        a.rig.g.updateMatrixWorld(true);
        const at = a.rig.g.getWorldPosition(new THREE.Vector3());
        const rigBox = new THREE.Box3().setFromObject(a.rig.g);
        a.rig.g.traverse(o => {
          if (!o.isMesh || !/^(Cylinder|Box|Capsule)Geometry$/.test(o.geometry?.type)) return;
          const b = new THREE.Box3().setFromObject(o), size = b.getSize(new THREE.Vector3()).toArray(), c = b.getCenter(new THREE.Vector3());
          const long = Math.max(...size), axis = size.indexOf(long), mid = [...size].sort((p, q) => q - p)[1];
          if (long < 1.3 || long < 8 * mid) return;               // a long straight body (a pencil, a snake) is fine
          // lying high up: a branch or perch to hang or sit on; a flier's wing, across its body's middle, is not
          const wing = a.move === 'fly' && c.y - rigBox.min.y > 0.25 * (rigBox.max.y - rigBox.min.y);
          const bar = axis !== 1 && c.y - at.y > 0.8 && !wing;
          const post = axis === 1 && b.min.y - at.y < 0.15 && Math.hypot(c.x - at.x, c.z - at.z) > 0.6;   // down to the ground, away from its feet
          if (bar || post) pole.push(long.toFixed(1));
        });
        // built up in the air (the sim keeps rig.g on the ground): it hangs from something above it or sits on
        // something under it (a swing, a nest, a wall). Supported here when this module has scenery (outside
        // the rig) over its spot that reaches its top or whose top is where it sits.
        if (a.move !== 'fly' && a.move !== 'swim' && rigBox.min.y - at.y > 0.6) {
          const cx = (rigBox.min.x + rigBox.max.x) / 2, cz = (rigBox.min.z + rigBox.max.z) / 2, top = rigBox.max.y, bottom = rigBox.min.y;
          let own = false;
          ctx.world.traverse(o => {
            if (!o.isMesh || own) return;
            let inRig = false; o.traverseAncestors(p => { if (p === a.rig.g) inRig = true; });
            if (inRig) return;
            const b = new THREE.Box3().setFromObject(o);
            if ((b.max.y >= top - 0.3 || Math.abs(b.max.y - bottom) <= 0.3) && b.min.x - 0.3 <= cx && cx <= b.max.x + 0.3 && b.min.z - 0.3 <= cz && cz <= b.max.z + 0.3) own = true;
          });
          (info.hanging ||= []).push({ id: a.id, x: +cx.toFixed(2), z: +cz.toFixed(2), top: +top.toFixed(2), bottom: +bottom.toFixed(2), supported: own });
        }
        if (pole.length) problems.push(`actor ${a.id}: its rig carries a long thin pole or branch (${pole.join(', ')} long), which would walk around with it; the rig is only the body: build what it hangs from, sits on or stands in as its own thing without actors`);
      }
      if (typeof a.rig?.say !== 'function') problems.push(`actor ${a.id}: rig.say(text) is missing`);
      if (!a.rig?.kind) problems.push(`actor ${a.id}: rig.kind is missing`);
      if (a.move != null && !['walk', 'hop', 'crawl', 'fly', 'swim', 'climb'].includes(a.move)) problems.push(`actor ${a.id}: move must be 'walk', 'hop', 'crawl', 'fly', 'swim' or 'climb' (got ${JSON.stringify(a.move)})`);
      if (a.rig?.kind && a.rig.kind !== 'person' && typeof a.rig.animate !== 'function')
        problems.push(`actor ${a.id}: kind "${a.rig.kind}" has no rig.animate, so the sim would animate it as a person with arms and legs it lacks`);
      if (a.start && !(Array.isArray(a.start) && a.start.length === 2 && a.start.every(num))) problems.push(`actor ${a.id}: start must be [x, z]`);
      if (typeof a.rig?.animate === 'function') {
        for (const s of STATES) {
          try { for (let i = 0; i < 3; i++) a.rig.animate(s, i * 0.4, s === 'walk', { ...a, pos: new THREE.Vector3(), speed: 1 }); }
          catch (e) { problems.push(`actor ${a.id}: animate('${s}') throws: ${e.message}`); break; }
        }
      }
    }
    // the real sim, as the book runs it (live 2026-10-17: a 'person' rig without the person's limbs threw
    // every frame and froze every figure after it). Only once the rig itself is sound.
    if (!problems.length) for (const a of actors) {
      const r = await simThrows(a);
      if (r?.skipped) { info.simSkipped = r.skipped.slice(0, 200); break; }
      if (r?.error) problems.push(`actor ${a.id}: the book's sim throws when it moves and animates it: ${r.error}` +
        (!a.rig.animate ? `. Without rig.animate the sim animates it as a person (makePerson's armL, armR, legL, legR, head, body): build it with makePerson, or give the rig its own animate(state, t, moving)` : ''));
    }
    // speech: each lines group is a German array (old shape) or { de: [...], en: [...] } of the same length
    // everything a character can say passes the same child-safe filter as the dialogues (viewer/dialogues.js)
    const { safeLine } = await import(pathToFileURL(join(VIEWER, 'dialogues.js')).href);
    const unsafe = (list, lang) => list.filter(x => typeof x === 'string' && !safeLine(x, lang));
    const linesOk = (g, where) => {
      const bad = Array.isArray(g) ? unsafe(g, 'de') : g && typeof g === 'object' ? [...unsafe(g.de || [], 'de'), ...unsafe(g.en || [], 'en')] : [];
      if (bad.length) problems.push(`${where}: not right for children: ${bad.map(x => JSON.stringify(x)).join(', ')}`);
      if (Array.isArray(g)) return g.every(x => typeof x === 'string') || problems.push(`${where}: lines must be strings`);
      if (!g || typeof g !== 'object' || !Array.isArray(g.de) || !Array.isArray(g.en)) return problems.push(`${where}: lines need { de: [...], en: [...] }`);
      if (g.de.length !== g.en.length) problems.push(`${where}: ${g.de.length} German but ${g.en.length} English lines; give each line its twin`);
      if (![...g.de, ...g.en].every(x => typeof x === 'string' && x.length <= 120)) problems.push(`${where}: lines must be short strings`);
    };
    // lines.said: the words drawn in its bubble, said once when it arrives (one string each, not a list)
    const saidOk = (g, where) => {
      if (!g || typeof g.de !== 'string' || typeof g.en !== 'string' || g.de.length > 120 || g.en.length > 120) return problems.push(`${where}: said is one short line { de: '...', en: '...' }`);
      if (!safeLine(g.de, 'de') || !safeLine(g.en, 'en')) problems.push(`${where}: not right for children: ${JSON.stringify(g)}`);
    };
    for (const a of actors) for (const [k, g] of Object.entries(a?.lines || {})) (k === 'said' ? saidOk : linesOk)(g, `actor ${a?.id} lines.${k}`);
    for (const a of actors) if (a?.said !== undefined) problems.push(`actor ${a?.id}: said belongs inside its lines: lines: { said: { de, en }, greet: ... }`);
    for (const sp of spots) if (sp?.lines) linesOk(sp.lines, `spot ${sp.kind} lines`);
    for (const o of obstacles) if (!num(o?.x) || !num(o?.z) || !num(o?.r)) { problems.push('obstacles need numeric { x, z, r }'); break; }
    for (const s of spots) if (!s?.kind || !num(s?.x) || !num(s?.z)) { problems.push('spots need { kind, x, z }'); break; }
    // holds: this thing keeps an actor (its own or another thing's) inside a circle, e.g. a jail around the spider
    for (const h of [].concat(r.holds || [])) {
      if (!h?.actor || !num(h.x) || !num(h.z) || !num(h.r) || h.r <= 0) { problems.push('holds need { actor, x, z, r } with r > 0'); continue; }
      if (!takenIds.includes(h.actor) && !actors.some(a => a?.id === h.actor)) problems.push(`holds names actor "${h.actor}", which is on the island nowhere`);
      if (h.r < 0.4) problems.push(`holds "${h.actor}" in r=${h.r}: too small to move in (at least 0.4)`);
      if (obstacles.some(o => num(o?.r) && o.r >= 0.5 * h.r && Math.hypot(o.x - h.x, o.z - h.z) < o.r))
        problems.push(`holds "${h.actor}" has no room inside: an obstacle covers its centre; model the walls as a ring of small obstacles`);
    }
    // heldBy: this thing is held by a character and moves with it ({ actor, at: [x, y, z] } in the actor's space)
    if (r.heldBy != null) {
      const h = r.heldBy;
      if (!h?.actor || !takenIds.includes(h.actor)) problems.push(`heldBy names actor "${h?.actor}", which is on the island nowhere`);
      if (h?.at != null && !(Array.isArray(h.at) && h.at.length === 3 && h.at.every(num))) problems.push('heldBy.at must be [x, y, z] (right, up, forward from the actor)');
      if (meshes && Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) > 4) problems.push('a held thing must be hand-sized (under 4 across, beam included), built around (0, 0, 0)');
    }
    // weather (the engine's weather contract): { kind } or a list
    for (const w of [].concat(r.weather ?? [])) {
      if (!['rain', 'snow', 'rainbow', 'lightning'].includes(w?.kind)) problems.push(`weather.kind must be 'rain', 'snow', 'rainbow' or 'lightning' (got ${JSON.stringify(w?.kind)})`);
    }
    // light (the engine's light contract): one object or a list of { kind, object3D, color, intensity, range, flicker }
    const lights = r.light == null ? [] : [].concat(r.light);
    // a hand-built shape (a raw BufferGeometry: a lofted hill, a ridge) whose faces wind inward renders black from
    // outside (10-19: 2 of 6 hills, orange material, came out black). Flat meshes have no inside and are left out
    {
      let inwardMeshes = 0;
      ctx.world.traverse(o => { if (o.isMesh && o.geometry?.type === 'BufferGeometry' && inwardShare(o.geometry) > 0.6) inwardMeshes++; });
      info.inwardMeshes = inwardMeshes;                    // advisory: generate asks once for a fix (finish)
    }
    info.lights = lights.map(l => ({ kind: l?.kind, glows: !!l?.object3D?.isObject3D }));   // a luminous drawing must have one
    // could a figure pick it up? the viewer decides by the same rule (portable.js); the quest writer asks for 'bring'
    {
      const foot = footprintOf(ctx.world, THREE, 0.3 * BASE.w * BASE.d);
      let pond = false; ctx.world.traverse(o => { if (o.userData?.zone) pond = true; });
      info.portable = !!foot && isPortable({ hx: foot.hx, hz: foot.hz, top: foot.top, lightKinds: lights.map(l => l?.kind), weather: [].concat(r.weather ?? []).length,
        spotKinds: [].concat(r.spots ?? []).map(sp => sp?.kind), actors: [].concat(r.actors ?? []).length, holds: [].concat(r.holds ?? []).length, heldBy: !!r.heldBy, pond });
    }
    for (const l of lights) {
      if (!['sun', 'moon', 'lamp'].includes(l?.kind)) { problems.push(`light.kind must be 'sun', 'moon' or 'lamp' (got ${JSON.stringify(l?.kind)})`); continue; }
      if (l.object3D != null && !l.object3D.isObject3D) problems.push(`${l.kind} light: object3D must be a mesh or group of this thing`);
      if (l.intensity != null && !(num(l.intensity) && l.intensity >= 0 && l.intensity <= 5)) problems.push(`${l.kind} light: intensity must be 0-5`);
      if (l.range != null && !(num(l.range) && l.range > 0 && l.range <= 20)) problems.push(`${l.kind} light: range must be 0-20 (the island is 14 across)`);
    }
    const lamps = lights.filter(l => l?.kind === 'lamp').length;
    if (lamps > 3) problems.push(`${lamps} lamps: at most 3 per thing (the engine lights only that many; make the others glow with an emissive material instead)`);
    if (r.update) {
      if (typeof r.update !== 'function') problems.push('update must be a function');
      // 30 simulated seconds, so something that only starts later (if (t > 5) ...) runs too
      else try { for (let i = 0; i < 120; i++) r.update(i / 4, 1 / 4, ctx.env); } catch (e) { problems.push(`update() throws: ${e.message}`); }
    }
    return { problems, info };
  }
}

const [mode, file, taken] = process.argv.slice(2);
let result;
if (mode === 'meta') {
  try { result = { meta: (await import(pathToFileURL(file).href)).meta || null }; } catch (e) { result = { error: e.message }; }
} else {
  result = await buildCheck(file, JSON.parse(taken || '[]'));
}
out(JSON.stringify(result) + '\n');
process.exit(0);
