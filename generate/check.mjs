// Checks a generated things/*.js module before it may reach the viewer.
// They catch code that is broken or misbehaves, not code that looks wrong. Whether it
// looks like the drawing is the render + look step (render.mjs, generate.mjs).
import * as THREE from 'three';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VIEWER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'viewer');
const ISLAND_R = 6.9;
const STATES = ['idle', 'walk', 'talk', 'wave', 'dance', 'sit', 'scared', 'highfive', 'lookup', 'yawn', 'stretch'];

// Everything a thing needs comes in through ctx. A module that reaches for the page, the
// network or code evaluation is rejected, whatever it was meant for.
const FORBIDDEN = [
  [/^\s*import\b|\bimport\s*\(/m, 'imports (everything comes from ctx)'],
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator|sendBeacon)\b/, 'network access'],
  [/\b(document|window|globalThis|location|localStorage|sessionStorage|indexedDB)\b/, 'page / browser globals'],
  [/\beval\b|\bFunction\s*\(|new\s+Function\b|setTimeout\s*\(\s*['"`]/, 'code evaluation'],
  [/\b(Worker|importScripts|postMessage)\b/, 'workers / messaging'],
  [/\b(TextureLoader|FileLoader|ImageLoader|GLTFLoader|ObjectLoader)\b/, 'loading files'],
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
export async function buildCheck(code, { takenIds = [] } = {}) {
  const problems = [], info = {};
  const dir = mkdtempSync(join(tmpdir(), 'kritzel-check-'));
  try {
    const file = join(dir, 'thing.mjs');
    writeFileSync(file, code);
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
    if (r.update) {
      if (typeof r.update !== 'function') problems.push('update must be a function');
      else try { for (let i = 0; i < 120; i++) r.update(i / 60, 1 / 60, ctx.env); } catch (e) { problems.push(`update() throws: ${e.message}`); }
    }
    return { problems, info };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
