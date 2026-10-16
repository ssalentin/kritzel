// A fresh world for a fresh sheet of paper: only the floating island itself.
// Everything that lives here is drawn by the user and comes from things/*.js.
// (The previous world with Sqichy is archived in ../worlds/sqichy/.)
export const caption = '';

// prevState: characters' saved state (position, mood, friendships) so a reload doesn't reset them
export async function build(api, prevState = null) {
  const { THREE, scene, world, camera, bubble, shadowAll, report } = api;
  const v = '?v=' + Date.now();
  const [sim, islandMod, charMod, extra, waterMod] = await Promise.all(
    ['sim', 'island', 'characters', 'sim-extra', 'water'].map(f => import(`./${f}.js${v}`)));

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
  //   { actors: [...], obstacles: [{ x, z, r }], spots: [{ kind, x, z, lines }], holds: [{ actor, x, z, r }], update(t, dt, env),
  //     light: { kind: 'sun'|'moon'|'lamp', object3D, color, intensity, range, flicker } (or a list) }
  // Things are loaded one by one and can be added/changed/removed live — the rest of the
  // world (and every character's position, mood and friendships) keeps running.
  const env = { cover: 0 };
  // sound for things: ctx.sound.fx(name, object3D) — names: plopp, melodie, buh, mampf, piep, quak, staunen, rascheln, herz
  const sound = { fx: (name, obj) => api.sound?.fx(name, obj) };
  // water for drawn things: ctx.water.pond(x, z, r), .waterfall(from, to, width), .river(points, width)
  const water = waterMod.makeWater({ THREE, scene });
  const ctx = { THREE, world, bubble, shadowAll, mat, limb, rand, makePerson, pond, trees, SUN_POS, islandR: 6.9, env, sound,
    water: { pond: water.pond, waterfall: water.waterfall, river: water.river } };
  const loaded = new Map();               // file → { box, actors, obstacles, spots, update }
  let brain = null;

  // ---------- placement: a NEW thing goes to a free spot near where it is on the paper ----------
  // Where each thing ended up is kept in things/placement.json (file → [dx, dz]), so a reload or
  // a second viewer puts it in the same place. Things that were there before keep their place.
  // Once the file exists, a thing without an entry is new even if no viewer saw it arrive.
  let placed = {}, tracking = false;
  try { const r = await fetch('things/placement.json', { cache: 'no-store' }); if (r.ok) { placed = await r.json() || {}; tracking = true; } } catch {}
  // the first viewer to save a spot wins: if another one was quicker, take its spot
  const savePlace = async (file, d) => {
    if (d) placed[file] = d; else delete placed[file];
    try {
      const win = await (await fetch('/api/placement', { method: 'PUT', body: JSON.stringify({ file, d }) })).json();
      if (d && Array.isArray(win) && (win[0] !== d[0] || win[1] !== d[1]) && loaded.get(file)) {
        shift(loaded.get(file), win[0] - d[0], win[1] - d[1]);
        placed[file] = win;
      }
    } catch {}
  };
  // ground footprint of a thing (actors aside): centre and radius; null if it floats in the sky
  function footprint(box) {
    const b = new THREE.Box3().setFromObject(box);
    if (b.isEmpty() || b.min.y > 1.5) return null;
    return { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2, r: Math.max(0.4, Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) / 2) };
  }
  // the free spot nearest to (x, z) for something of radius r: on the island, off other things,
  // their obstacles, the characters and spots promised to drawings still being built
  function freeSpot(x, z, r, except = null) {
    const busy = [...(api.reserved?.() || [])];
    for (const [f, e] of loaded) if (f !== except) { if (e.foot) busy.push(e.foot); busy.push(...e.obstacles); }
    for (const a of brain?.actors?.() || []) busy.push({ x: a.pos.x, z: a.pos.z, r: 0.45 });
    const ok = (cx, cz) => Math.hypot(cx, cz) + r <= 6.6 && busy.every(o => Math.hypot(cx - o.x, cz - o.z) >= r + (o.r || 0.4) + 0.15);
    for (let ring = 0; ring <= 30; ring++) {
      const d = ring * 0.35, n = Math.max(1, Math.round(2 * Math.PI * d / 0.35));
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2 + ring;
        if (ok(x + Math.cos(a) * d, z + Math.sin(a) * d)) return { x: x + Math.cos(a) * d, z: z + Math.sin(a) * d };
      }
    }
    return { x, z };
  }
  // meta.paper { x, y } (0-1 of the frame) → island, the way generate places things
  const fromPaper = p => {
    let x = (p.x - 0.5) * 9, z = (p.y - 0.5) * 7;
    const r = Math.hypot(x, z);
    return r > 5 ? { x: x * 5 / r, z: z * 5 / r } : { x, z };
  };
  function shift(entry, dx, dz) {
    entry.box.position.x += dx; entry.box.position.z += dz;
    for (const o of [...entry.obstacles, ...entry.spots, ...entry.holds]) { o.x += dx; o.z += dz; }
    for (const a of entry.actors) {
      a.start = [(a.start?.[0] ?? 0) + dx, (a.start?.[1] ?? 0) + dz];
      if (a.pos && brain) { a.pos.x += dx; a.pos.z += dz; }        // already walking: move along
    }
    if (entry.foot) { entry.foot.x += dx; entry.foot.z += dz; }
  }
  function place(file, entry, meta, live) {
    // characters are placed by the sim in world coordinates: they leave the box, only their start moves
    entry.free = new THREE.Group();
    for (const a of entry.actors) if (a.rig?.g) entry.free.add(a.rig.g);
    world.add(entry.free);
    const foot = footprint(entry.box);
    if (foot) entry.foot = { ...foot };
    // held by a character (it hangs on the actor's rig): never placed. Holding characters (a jail
    // drawn around someone): stays where it was drawn, or the relation would be lost
    if (entry.heldBy) return;
    let d = placed[file];
    const isNew = !d && (live || tracking);
    if (isNew && (entry.holds.length || (!foot && !entry.actors.length))) d = [0, 0];
    if (d && !placed[file]) savePlace(file, d);
    if (!d && isNew && foot) {
      const p = meta?.paper;
      const wish = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? fromPaper(p) : foot;
      const spot = (live && api.claimSpot?.()) || freeSpot(wish.x, wish.z, foot.r, file);
      d = [+(spot.x - foot.x).toFixed(2), +(spot.z - foot.z).toFixed(2)];
      savePlace(file, d);
    } else if (!d && isNew && entry.actors.length) {     // a creature on its own: start it at a free spot
      const p = meta?.paper, wish = p ? fromPaper(p) : { x: 0, z: 0 };
      const spot = (live && api.claimSpot?.()) || freeSpot(wish.x, wish.z, 0.5, file);
      const s = entry.actors[0].start || [0, 0];
      d = [+(spot.x - s[0]).toFixed(2), +(spot.z - s[1]).toFixed(2)];
      savePlace(file, d);
    }
    if (d) shift(entry, d[0], d[1]);
  }

  async function loadThing(file, states, live = false) {
    const before = new Set(world.children);
    const entry = { box: new THREE.Group(), actors: [], obstacles: [], spots: [], holds: [], heldBy: null, update: null, light: [] };
    let m = null;
    try {
      m = await import('./things/' + file + '?v=' + Date.now());
      water.begin();
      const r = (await m.build(ctx)) || {};
      if (water.ignored()) report(`things/${file}: ${water.ignored()} water piece(s) left out (at most 6 per thing)`);
      Object.assign(entry, { actors: r.actors || [], obstacles: r.obstacles || [], spots: r.spots || [], holds: r.holds || [], heldBy: r.heldBy || null, update: r.update || null,
        light: [].concat(r.light || []) });
    } catch (e) { report(`things/${file}: ${e.message}`); }
    // everything this thing put into the world goes into its own box, so it can be removed later
    for (const o of [...world.children]) if (!before.has(o)) entry.box.add(o);
    world.add(entry.box);
    try { place(file, entry, m?.meta, live); } catch (e) { report(`things/${file}: placing: ${e.message}`); }
    bakeAO(THREE, entry.box);
    if (entry.free) bakeAO(THREE, entry.free);
    if (live) api.arrived?.(entry.box, entry.free);
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
    // things this one's actors hold go back to the world first, so they are not disposed with it
    // (the actors' rigs hang in entry.free since placement, the rest in entry.box)
    for (const e of loaded.values()) {
      if (e === entry || !e.heldBy) continue;
      let p = e.box.parent;
      while (p && p !== entry.box && p !== entry.free) p = p.parent;
      if (p && (p === entry.box || p === entry.free)) { world.add(e.box); e.box.position.set(0, 0, 0); }
    }
    entry.box.parent?.remove(entry.box);       // in the world, or in the hand of whoever held it
    if (entry.free) { world.remove(entry.free); entry.free.traverse(o => { o.geometry?.dispose(); [].concat(o.material || []).forEach(m => m.dispose()); }); }
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
    brain.setHolds([...loaded.values()].flatMap(e => e.holds));
    attachHeld();
  }
  // a thing held by a character (a flashlight in Bana's hand): its box hangs on the actor's rig at
  // heldBy.at (actor space: x right, y up, z forward), so it walks and turns along; back to the world
  // if that actor is gone. Re-done after every reload, since a reloaded actor has a new rig.
  function attachHeld() {
    const byId = brain.byId();
    for (const e of loaded.values()) {
      if (!e.heldBy) continue;
      const g = byId[e.heldBy.actor]?.rig?.g, at = Array.isArray(e.heldBy.at) && e.heldBy.at.length === 3 ? e.heldBy.at : [0, 1, 0.4];
      if (g && e.box.parent !== g) { g.add(e.box); e.box.position.set(...at); }
      else if (!g && e.box.parent !== world) { world.add(e.box); e.box.position.set(0, 0, 0); }
    }
  }

  const listing = await (await fetch('things/', { cache: 'no-store' })).text();
  for (const [, file] of listing.matchAll(/href="([\w.-]+\.js)"/g)) await loadThing(file);
  const actors = [...loaded.values()].flatMap(e => e.actors);
  for (const e of loaded.values()) trees.push(...e.obstacles);
  const spots = [...loaded.values()].flatMap(e => e.spots);
  brain = sim.create({ THREE, actors, trees, pond, spots, islandR: 6.9, states: prevState, extra });
  brain.setHolds([...loaded.values()].flatMap(e => e.holds));
  attachHeld();

  return {
    // engine calls this when only things/ changed: reload just those files
    async reloadThings(changed, removed) {
      const states = brain.snapshot();
      const fresh = new Set(changed.filter(f => !loaded.has(f)));
      for (const f of [...changed, ...removed]) unloadThing(f);
      for (const f of removed) if (placed[f]) savePlace(f, null);
      for (const f of changed) await loadThing(f, states, fresh.has(f));
      refreshWorld();
    },
    snapshot: () => brain.snapshot(),
    freeSpot: (x, z, r) => freeSpot(x, z, r),   // for the light that shows where a drawing will appear
    brain: () => brain,                   // for UI in index.html (e.g. click a character); sim exposes its actors
    update(t, dt) {
      island.update(t);
      water.tick(t);
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
