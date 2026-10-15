// Runs one things/*.js module for real, in a child process that check.mjs starts sandboxed:
// no network (own network namespace), node --permission (no fs writes, no child processes,
// no workers, reads only three, viewer/ and the module), killed after a few seconds.
//   node check-run.mjs meta  <module.mjs>                 → {"meta": {...}}
//   node check-run.mjs build <module.mjs> <takenIdsJSON>  → {"problems": [...], "info": {...}}
// The module runs in this process, so a hostile one could fake this output. That is why the
// sandbox, not this result, is what protects the host.
import * as THREE from 'three';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VIEWER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'viewer');
const ISLAND_R = 6.9;
const STATES = ['idle', 'walk', 'talk', 'wave', 'dance', 'sit', 'scared', 'highfive', 'lookup', 'yawn', 'stretch'];
const out = process.stdout.write.bind(process.stdout);   // taken before the module can replace it

// The same ctx world.js builds, minus the browser parts (speech bubbles, sound are stubs).
async function makeCtx() {
  const world = new THREE.Group();
  const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, flatShading: true, ...opts });
  const limb = (len, r, m) => {
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len - 2 * r, 6, 12), m);
    mesh.position.y = -len / 2;
    pivot.add(mesh);
    return pivot;
  };
  const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
  const bubble = () => ({ say() {} });
  const shadowAll = o => o.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  const { makeCharacters } = await import(pathToFileURL(join(VIEWER, 'characters.js')).href);
  const { makePerson } = makeCharacters({ THREE, world, mat, limb, bubble, shadowAll });
  const env = { cover: 0, actors: [] };
  return { THREE, world, bubble, shadowAll, mat, limb, rand, makePerson, pond: { x: 0, z: 0, r: 0 }, trees: [],
    SUN_POS: new THREE.Vector3(2.5, 6.8, -6.5), islandR: ISLAND_R, env, sound: { fx() {} } };
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

    const box = new THREE.Box3().setFromObject(ctx.world);
    let meshes = 0;
    ctx.world.traverse(o => { if (o.isMesh) meshes++; });
    info.meshes = meshes;
    if (!meshes) problems.push('build() added nothing visible to ctx.world');
    else {
      info.box = { min: box.min.toArray().map(v => +v.toFixed(2)), max: box.max.toArray().map(v => +v.toFixed(2)) };
      const reach = Math.max(...[box.min.x, box.max.x, box.min.z, box.max.z].map(Math.abs));
      if (reach > ISLAND_R) problems.push(`reaches ${reach.toFixed(1)} from the centre; the island's radius is ${ISLAND_R}`);
      if (box.min.y < -0.6) problems.push(`sinks into the ground (lowest point y=${box.min.y.toFixed(2)})`);
      if (box.max.y - box.min.y > 7) problems.push(`is ${(box.max.y - box.min.y).toFixed(1)} tall; a person is ~2.2`);
      if (box.max.y - box.min.y < 0.1) problems.push('is flat (under 0.1 tall)');
    }

    const actors = r.actors || [], obstacles = r.obstacles || [], spots = r.spots || [];
    for (const [name, arr] of [['actors', actors], ['obstacles', obstacles], ['spots', spots]])
      if (!Array.isArray(arr)) problems.push(`${name} must be an array`);
    info.actors = actors.map(a => a?.id);
    const ids = new Set(takenIds);
    for (const a of actors) {
      if (!a?.id || typeof a.id !== 'string') { problems.push('an actor has no string id'); continue; }
      if (ids.has(a.id)) problems.push(`actor id "${a.id}" is already taken`);
      ids.add(a.id);
      if (!a.rig?.g?.isObject3D) problems.push(`actor ${a.id}: rig.g must be its THREE.Group`);
      else { let inWorld = false; a.rig.g.traverseAncestors(p => { if (p === ctx.world) inWorld = true; }); if (!inWorld) problems.push(`actor ${a.id}: rig.g is not in ctx.world`); }
      if (typeof a.rig?.say !== 'function') problems.push(`actor ${a.id}: rig.say(text) is missing`);
      if (!a.rig?.kind) problems.push(`actor ${a.id}: rig.kind is missing`);
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
    for (const o of obstacles) if (!num(o?.x) || !num(o?.z) || !num(o?.r)) { problems.push('obstacles need numeric { x, z, r }'); break; }
    for (const s of spots) if (!s?.kind || !num(s?.x) || !num(s?.z)) { problems.push('spots need { kind, x, z }'); break; }
    // holds: this thing keeps an actor (its own or another thing's) inside a circle, e.g. a jail around the spider
    for (const h of [].concat(r.holds || [])) {
      if (!h?.actor || !num(h.x) || !num(h.z) || !num(h.r) || h.r <= 0) { problems.push('holds need { actor, x, z, r } with r > 0'); continue; }
      if (!takenIds.includes(h.actor) && !actors.some(a => a?.id === h.actor)) problems.push(`holds names actor "${h.actor}", which is on the island nowhere`);
      if (h.r < 0.4) problems.push(`holds "${h.actor}" in r=${h.r}: too small to move in (at least 0.4)`);
    }
    // light (the engine's light contract): one object or a list of { kind, object3D, color, intensity, range, flicker }
    const lights = r.light == null ? [] : [].concat(r.light);
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
