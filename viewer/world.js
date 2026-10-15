// A fresh world for a fresh sheet of paper: only the floating island itself.
// Everything that lives here is drawn by the user and comes from things/*.js.
// (The previous world with Sqichy is archived in ../worlds/sqichy/.)
export const caption = '';

// prevState: characters' saved state (position, mood, friendships) so a reload doesn't reset them
export async function build(api, prevState = null) {
  const { THREE, world, camera, bubble, shadowAll, report } = api;
  const v = '?v=' + Date.now();
  const [sim, islandMod, charMod, extra] = await Promise.all(
    ['sim', 'island', 'characters', 'sim-extra'].map(f => import(`./${f}.js${v}`)));

  // shared look: soft pastel low-poly materials (flat shaded unless asked otherwise)
  const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, flatShading: true, ...opts });
  const limb = (len, r, m) => {
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len - 2 * r, 6, 12), m);
    mesh.position.y = -len / 2;
    pivot.add(mesh);
    return pivot;
  };
  const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);

  // ---------- the island: grass top, soil, rock, roots — no water, no sky props ----------
  const pond = { x: 0, z: 0, r: 0 };
  const trees = [];                       // obstacles; drawn things add theirs
  const island = islandMod.buildIsland({ THREE, world, mat, rand, pond, camera, waterfall: false, sky: false });

  // (no grass tufts or pebbles: the grass top stays calm, softly painted like the example)

  // light: the scene's key light is placed by mood.js (from a drawn sun or moon, or the time of day)
  const SUN_POS = new THREE.Vector3(2.5, 6.8, -6.5);
  api.mood?.reset();

  // ---------- character helpers for drawn figures ----------
  const { makePerson } = charMod.makeCharacters({ THREE, world, mat, limb, bubble, shadowAll });

  // ---------- drawn things: every file in things/ adds itself to the world ----------
  // contract: export const meta = { name, drawing }; export function build(ctx) → optional
  //   { actors: [...], obstacles: [{ x, z, r }], spots: [{ kind, x, z, lines }], update(t, dt, env),
  //     light: { kind: 'sun'|'moon'|'lamp', object3D, color, intensity, range, flicker } (or a list) }
  // Things are loaded one by one and can be added/changed/removed live — the rest of the
  // world (and every character's position, mood and friendships) keeps running.
  const env = { cover: 0 };
  // sound for things: ctx.sound.fx(name, object3D) — names: plopp, melodie, buh, mampf, piep, quak, staunen, rascheln, herz
  const sound = { fx: (name, obj) => api.sound?.fx(name, obj) };
  const ctx = { THREE, world, bubble, shadowAll, mat, limb, rand, makePerson, pond, trees, SUN_POS, islandR: 6.9, env, sound };
  const loaded = new Map();               // file → { box, actors, obstacles, spots, update }
  let brain = null;

  async function loadThing(file, states) {
    const before = new Set(world.children);
    const entry = { box: new THREE.Group(), actors: [], obstacles: [], spots: [], update: null, light: [] };
    try {
      const m = await import('./things/' + file + '?v=' + Date.now());
      const r = (await m.build(ctx)) || {};
      Object.assign(entry, { actors: r.actors || [], obstacles: r.obstacles || [], spots: r.spots || [], update: r.update || null,
        light: [].concat(r.light || []) });
    } catch (e) { report(`things/${file}: ${e.message}`); }
    // everything this thing put into the world goes into its own box, so it can be removed later
    for (const o of [...world.children]) if (!before.has(o)) entry.box.add(o);
    world.add(entry.box);
    bakeAO(THREE, entry.box);
    const dropped = api.mood?.set(file, entry.light, entry.box);
    if (dropped) report(`things/${file}: ${dropped} lamp(s) left dark (at most 3 per thing, 8 in all)`);
    loaded.set(file, entry);
    if (brain) { for (const a of entry.actors) brain.addActor(a, states?.[a.id]); }
    return entry;
  }
  function unloadThing(file) {
    const entry = loaded.get(file);
    if (!entry) return;
    for (const a of entry.actors) brain?.removeActor(a.id);
    api.mood?.set(file, []);
    world.remove(entry.box);
    entry.box.traverse(o => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach(m => { m.map?.dispose(); m.dispose(); });
    });
    loaded.delete(file);
  }
  function refreshWorld() {
    trees.length = 0;
    const spots = [];
    for (const e of loaded.values()) { trees.push(...e.obstacles); spots.push(...e.spots); }
    brain.setWorld({ trees, spots });
  }

  const listing = await (await fetch('things/', { cache: 'no-store' })).text();
  for (const [, file] of listing.matchAll(/href="([\w.-]+\.js)"/g)) await loadThing(file);
  const actors = [...loaded.values()].flatMap(e => e.actors);
  for (const e of loaded.values()) trees.push(...e.obstacles);
  const spots = [...loaded.values()].flatMap(e => e.spots);
  brain = sim.create({ THREE, actors, trees, pond, spots, islandR: 6.9, states: prevState, extra });

  return {
    // engine calls this when only things/ changed: reload just those files
    async reloadThings(changed, removed) {
      const states = brain.snapshot();
      for (const f of [...changed, ...removed]) unloadThing(f);
      for (const f of changed) await loadThing(f, states);
      refreshWorld();
    },
    snapshot: () => brain.snapshot(),
    brain: () => brain,                   // for UI in index.html (e.g. click a character); sim exposes its actors
    update(t, dt) {
      island.update(t);
      for (const e of loaded.values()) {
        if (!e.update) continue;
        try { e.update(t, dt, env); } catch (err) { report('things: ' + err.message); e.update = null; }
      }
      env.actors = brain.actors?.() || [];   // living props (e.g. a tree with a face) can react to who is near
      env.night = api.mood?.night ?? 0;      // 0 day … 1 night: characters get sleepy and gather at lamps
      env.lamps = api.mood?.lamps() ?? [];
      brain.update(t, dt, env);
    },
  };
}

// "Baked" ambient occlusion like the hand-painted textures of the Littlest Tokyo example:
// every drawn object gets darker towards its own bottom (contact with the ground), via vertex colours.
// Meshes that already carry vertex colours (the island) are left alone.
function bakeAO(THREE, container) {
  const v = new THREE.Vector3(), box = new THREE.Box3();
  for (const root of container.children) {
    if (!root.isGroup) continue;
    root.updateMatrixWorld(true);
    box.setFromObject(root);
    if (box.isEmpty()) continue;
    const h = Math.max(0.3, box.max.y - box.min.y);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const yMin = v.copy(box.min).applyMatrix4(inv).y;
    const span = Math.min(1.2, h * 0.5) / (root.scale.y || 1);
    root.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry?.attributes.position) return;
      const mats = [].concat(o.material);
      if (mats.some(m => m.vertexColors && !m.userData.ao) || mats.some(m => m.transparent)) return;
      const g = o.geometry.userData.ao ? o.geometry : (o.geometry = o.geometry.clone());
      g.userData.ao = true;
      const p = g.attributes.position, cols = new Float32Array(p.count * 3);
      const toRoot = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(toRoot);
        const k = Math.min(1, Math.max(0, (v.y - yMin) / span));
        const c = 0.62 + 0.38 * k * k * (3 - 2 * k);
        cols[i * 3] = c; cols[i * 3 + 1] = c * 0.99; cols[i * 3 + 2] = c * 1.02;   // slightly cool shade
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      for (const m of mats) { m.vertexColors = true; m.userData.ao = true; m.needsUpdate = true; }
    });
  }
}
