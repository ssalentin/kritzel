// A fresh world for a fresh sheet of paper: only the floating island itself.
// Everything that lives here is drawn by the user and comes from things/*.js.
// (The previous world with Sqichy is archived in ../worlds/sqichy/.)
export const caption = '';

// prevState: characters' saved state (position, mood, friendships) so a reload doesn't reset them
export async function build(api, prevState = null) {
  const { THREE, scene, world, camera, bubble, shadowAll, report } = api;
  const v = '?v=' + Date.now();
  const [sim, bookMod, charMod, extra, waterMod, moves] = await Promise.all(
    ['sim', 'book', 'characters', 'sim-extra', 'water', 'moves'].map(f => import(`./${f}.js${v}`)));
  const { GROUND, FIT_R, groundY } = bookMod;

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

  // ---------- the ground: an open pop-up book (book.js); island.js only lives on in archived worlds ----------
  const pond = { x: 0, z: 0, r: 0 };
  const trees = [];                       // obstacles; drawn things add theirs
  const island = bookMod.buildBook({ THREE, world });
  // how far a shape at (s.x, s.z) reaches past the pages (0 = on them)
  const offGround = s => s.hx !== undefined
    ? Math.max(0, Math.abs(s.x) + s.hx - (GROUND.w / 2 - 0.2), Math.abs(s.z) + s.hz - (GROUND.d / 2 - 0.2))
    : Math.max(0, Math.abs(s.x) + (s.r || 0.4) - (GROUND.w / 2 - 0.2), Math.abs(s.z) + (s.r || 0.4) - (GROUND.d / 2 - 0.2));

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
  const ctx = { THREE, world, bubble, shadowAll, mat, limb, rand, makePerson, pond, trees, SUN_POS, islandR: FIT_R, ground: GROUND, env, sound,
    water: { pond: water.pond, waterfall: water.waterfall, river: water.river } };
  const loaded = new Map();               // file → { box, actors, obstacles, spots, update }
  let brain = null, clockNow = 0;

  // ---------- placement: a NEW thing goes to a free spot near where it is on the paper ----------
  // Where each thing ended up is kept in things/placement.json (file → [dx, dz]), so a reload or
  // a second viewer puts it in the same place. Things that were there before keep their place.
  // Once the file exists, a thing without an entry is new even if no viewer saw it arrive.
  let placed = {}, tracking = false;
  try { const r = await fetch('things/placement.json', { cache: 'no-store' }); if (r.ok) { placed = await r.json() || {}; tracking = true; } } catch {}
  // the first viewer to save a spot wins: if another one was quicker, take its spot
  const savePlace = async (file, d, force = false) => {
    if (d) placed[file] = d; else delete placed[file];
    try {
      const win = await (await fetch('/api/placement', { method: 'PUT', body: JSON.stringify({ file, d, force }) })).json();
      if (d && Array.isArray(win) && (win[0] !== d[0] || win[1] !== d[1]) && loaded.get(file)) {
        shift(loaded.get(file), win[0] - d[0], win[1] - d[1]);
        placed[file] = win;
      }
    } catch {}
  };
  // ground footprint of a thing (actors aside): the rectangle it covers (centre x, z and half
  // sizes hx, hz; r for things that need a circle); null if it floats in the sky
  // Flat pieces on the ground (water, paths, puddles: under 0.15 tall) don't count, and a thing that
  // still covers more than 30% of the island is ground itself: it neither moves nor blocks.
  function footprint(box) {
    const b = new THREE.Box3(), m = new THREE.Box3();
    box.updateMatrixWorld(true);
    box.traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      m.setFromObject(o, true);                              // vertex-exact
      if (m.max.y - m.min.y < 0.15 && m.max.y < 0.35) return;
      b.union(m);
    });
    if (b.isEmpty() || b.min.y > 1.5) return null;
    if ((b.max.x - b.min.x) * (b.max.z - b.min.z) > 0.3 * GROUND.w * GROUND.d) return null;
    const hx = Math.max(0.3, (b.max.x - b.min.x) / 2), hz = Math.max(0.3, (b.max.z - b.min.z) / 2);
    return { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2, hx, hz, r: Math.max(0.4, Math.hypot(hx, hz)), top: b.max.y };
  }
  // how far two shapes reach into each other (0 = apart, by at least `gap`): a shape is a circle
  // { x, z, r } or a rectangle { x, z, hx, hz }
  function depth(p, q, gap = 0) {
    const rect = s => s.hx !== undefined;
    if (rect(p) && rect(q)) return Math.max(0, Math.min(p.hx + q.hx + gap - Math.abs(p.x - q.x), p.hz + q.hz + gap - Math.abs(p.z - q.z)));
    if (rect(q)) [p, q] = [q, p];
    const r = (q.r || 0.4) + gap;
    if (rect(p)) return Math.max(0, r - Math.hypot(Math.max(0, Math.abs(q.x - p.x) - p.hx), Math.max(0, Math.abs(q.z - p.z) - p.hz)));
    return Math.max(0, (p.r || 0.4) + r - Math.hypot(p.x - q.x, p.z - q.z));
  }
  // the free spot nearest to (x, z) for `shape` (a radius, or a footprint to move): on the island,
  // off other things, their obstacles, the characters and spots promised to drawings still being
  // built. If nothing is entirely free, the spot where it overlaps least.
  function freeSpot(x, z, shape, except = null) {
    const busy = [...(api.reserved?.() || [])];
    for (const [f, e] of loaded) if (f !== except && !e.heldBy) { if (e.foot) busy.push(e.foot); busy.push(...e.obstacles); }   // held: in a hand
    for (const a of brain?.actors?.() || []) busy.push({ x: a.pos.x, z: a.pos.z, r: 0.45 });
    const at = (cx, cz) => typeof shape === 'number' ? { x: cx, z: cz, r: shape } : { ...shape, x: cx, z: cz };
    let best = null, bestCost = Infinity;
    for (let ring = 0; ring <= 30; ring++) {
      const d = ring * 0.35, n = Math.max(1, Math.round(2 * Math.PI * d / 0.35));
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2 + ring, s = at(x + Math.cos(a) * d, z + Math.sin(a) * d);
        const cost = offGround(s) * 4 + busy.reduce((c, o) => c + depth(s, o, 0.15), 0);
        if (cost === 0) return { x: s.x, z: s.z };
        if (cost < bestCost - 1e-6) { bestCost = cost; best = { x: s.x, z: s.z }; }
      }
    }
    return best || { x, z };
  }
  // meta.paper { x, y } (0-1 of the frame) → island, the way generate places things
  const fromPaper = p => {
    // the whole frame onto the whole pages (with a margin): a fresh page fills where things were drawn
    return { x: Math.max(-8.3, Math.min(8.3, (p.x - 0.5) * 16.6)), z: Math.max(-6, Math.min(6, (p.y - 0.5) * 12)) };
  };
  // stand a thing on the page's curve: at the highest the page gets under all of it (flat ponds and
  // rivers included), so no part sinks under the paper. Sky things (above 1.5) and held things stay.
  function onPage(entry) {
    if (entry.heldBy) return;
    entry.box.position.y = 0;
    const b = new THREE.Box3().setFromObject(entry.box, true);
    if (b.isEmpty() || b.min.y > 1.5) return;
    let top = -Infinity;
    for (let i = 0; i <= 12; i++) top = Math.max(top, groundY(b.min.x + (b.max.x - b.min.x) * i / 12));
    entry.box.position.y = top;
  }
  // a small thing a figure can pick up (sim-extra.js: 'portable'): it has no figure or hold in it and fits in a hand
  function ensurePortable(e) {
    if (e.portable || !e.foot || e.heldBy || e.actors.length || e.holds.length) return;
    if (Math.max(e.foot.hx, e.foot.hz) * 2 > 2 || e.foot.top > 2.5) return;
    // a house, a lamp, a sky or a pond is not carried: only things whose spots (a biscuit's food) can come along
    if (e.light.length || e.weather.length || e.spots.some(s => s.kind !== 'food')) return;
    let pond = false; e.box.traverse(o => { if (o.userData?.zone) pond = true; });
    if (pond) return;
    e.portable = { kind: 'portable', name: e.meta?.name, x: e.foot.x, z: e.foot.z, carrier: null };
    e.syncAt = { x: e.foot.x, z: e.foot.z };
    e.spots.push(e.portable);
  }
  // a carried thing follows its carrier, up in the hand; a dropped one lies on the page again
  // Its spots and obstacles come along. Returns true when it was picked up or put down (the grid is set up again).
  function followPortable(e) {
    const p = e.portable;
    const dx = p.x - e.syncAt.x, dz = p.z - e.syncAt.z;
    if (dx || dz) {
      e.box.position.x += dx; e.box.position.z += dz; e.foot.x += dx; e.foot.z += dz; e.syncAt = { x: p.x, z: p.z };
      for (const o of [...e.obstacles, ...e.spots]) if (o !== p) { o.x += dx; o.z += dz; }
    }
    if (p.carrier) { e.box.position.y = 1.1 + (p.carrier.alt || 0); if (p.held) return false; p.held = true; return true; }
    if (p.held) { p.held = false; onPage(e); return true; }
    return false;
  }
  function shift(entry, dx, dz) {
    entry.box.position.x += dx; entry.box.position.z += dz;
    if (entry.syncAt) { entry.syncAt.x += dx; entry.syncAt.z += dz; }
    for (const o of [...entry.obstacles, ...entry.spots, ...entry.holds]) { o.x += dx; o.z += dz; }
    for (const a of entry.actors) {
      a.start = [(a.start?.[0] ?? 0) + dx, (a.start?.[1] ?? 0) + dz];
      if (a.pos && brain) { a.pos.x += dx; a.pos.z += dz; }        // already walking: move along
    }
    if (entry.foot) { entry.foot.x += dx; entry.foot.z += dz; }
    onPage(entry);
  }
  function prepare(entry) {
    // characters are placed by the sim in world coordinates: they leave the box, only their start moves
    entry.free = new THREE.Group();
    for (const a of entry.actors) if (a.rig?.g) entry.free.add(a.rig.g);
    world.add(entry.free);
    const foot = footprint(entry.box);
    if (foot) entry.foot = { ...foot };
  }
  function place(file, entry, meta, live) {
    const foot = entry.foot && { ...entry.foot };
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
      const spot = (live && api.claimSpot?.()) || freeSpot(wish.x, wish.z, foot, file);
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
    else onPage(entry);
  }

  // things that pin their place: a jail holding someone, a thing in someone's hand, characters
  const pinned = e => e.holds.length || e.heldBy || e.actors.length;
  const shapes = e => [e.foot, ...e.obstacles].filter(Boolean);
  const overlap = (a, b) => shapes(a).some(p => shapes(b).some(q => depth(p, q, -0.05) > 0));
  // after every load: two things standing in each other → the one that came later (and is not
  // pinned) moves to the nearest free spot. 'recent' (just written or rewritten) counts as latest.
  function untangle(recent = new Set()) {
    const order = Object.keys(placed);
    const rank = f => recent.has(f) ? 2e6 + [...recent].indexOf(f) : order.includes(f) ? order.indexOf(f) : 1e6;
    const list = [...loaded].filter(([, e]) => e.foot && !e.heldBy).sort((a, b) => rank(a[0]) - rank(b[0]));
    const moved = [];
    // standing off the pages (a world made for the round island): onto them, if it may move
    for (const [f, e] of list) {
      if (pinned(e) || !offGround(e.foot)) continue;
      const spot = freeSpot(e.foot.x, e.foot.z, e.foot, f);
      const dx = +(spot.x - e.foot.x).toFixed(2), dz = +(spot.z - e.foot.z).toFixed(2);
      if (!dx && !dz) continue;
      shift(e, dx, dz);
      const d0 = placed[f] || [0, 0];
      savePlace(f, [+(d0[0] + dx).toFixed(2), +(d0[1] + dz).toFixed(2)], true);
      moved.push(`${f} onto the pages by (${dx}, ${dz})`);
      console.info(`placement: moved ${f} onto the pages by (${dx}, ${dz})`);
    }
    for (let i = 1; i < list.length; i++) {
      for (let j = 0; j < i; j++) {
        const [fa, a] = list[i], [fb, b] = list[j];
        if (!overlap(a, b)) continue;
        const [fm, mover, other] = !pinned(a) ? [fa, a, fb] : !pinned(b) ? [fb, b, fa] : [];
        if (!mover) continue;                       // both pinned: leave them, nothing sensible to do
        const spot = freeSpot(mover.foot.x, mover.foot.z, mover.foot, fm);
        const dx = +(spot.x - mover.foot.x).toFixed(2), dz = +(spot.z - mover.foot.z).toFixed(2);
        if (!dx && !dz) continue;
        shift(mover, dx, dz);
        const d0 = placed[fm] || [0, 0];
        savePlace(fm, [+(d0[0] + dx).toFixed(2), +(d0[1] + dz).toFixed(2)], true);
        moved.push(`${fm} out of ${other}'s way by (${dx}, ${dz})`);
        console.info(`placement: moved ${fm} out of ${other}'s way by (${dx}, ${dz})`);
      }
    }
    return moved;
  }

  async function loadThing(file, states, live = false, later = null) {
    const before = new Set(world.children);
    const entry = { box: new THREE.Group(), actors: [], obstacles: [], spots: [], holds: [], heldBy: null, update: null, light: [], weather: [] };
    let m = null;
    try {
      m = await import('./things/' + file + '?v=' + Date.now());
      water.begin();
      entry.meta = m.meta; entry.at = brain ? Date.now() : 0;   // arrived while the world was running: new
      const r = (await m.build(ctx)) || {};
      if (water.ignored()) report(`things/${file}: ${water.ignored()} water piece(s) left out (at most 6 per thing)`);
      for (const a of r.actors || []) a.file = file;           // for the sim's report of a figure that fails
      Object.assign(entry, { actors: r.actors || [], obstacles: r.obstacles || [], spots: r.spots || [], holds: r.holds || [], heldBy: r.heldBy || null, update: r.update || null, onTap: r.onTap || null,
        light: [].concat(r.light || []), weather: [].concat(r.weather || []) });
    } catch (e) { report(`things/${file}: ${e.message}`); }
    // everything this thing put into the world goes into its own box, so it can be removed later
    for (const o of [...world.children]) if (!before.has(o)) entry.box.add(o);
    world.add(entry.box);
    try {
      try { entry.update?.(0, 0, env); } catch {}           // a thing that sets its place in update (a cloud) is measured there
      prepare(entry);
      if (later) later.push([file, entry, m?.meta]);           // at page load: placed once everything is there
      else place(file, entry, m?.meta, live);
    } catch (e) { report(`things/${file}: placing: ${e.message}`); }
    if (STYLE === 'origami') { origami(THREE, entry.box); if (entry.free) origami(THREE, entry.free); }
    else if (STYLE === 'cutout') { cutout(THREE, entry.box); if (entry.free) cutout(THREE, entry.free); }
    else if (STYLE === 'crayon') { crayon(THREE, entry.box); if (entry.free) crayon(THREE, entry.free); }
    else { bakeAO(THREE, entry.box); if (entry.free) bakeAO(THREE, entry.free); }
    entry.base = entry.box.children.map(c => [c, c.scale.clone()]);   // true scales, before any grow-in
    entry.bornAt = clockNow;
    if (live) {                           // a drawing comes alive: the engine celebrates, the others come to look
      api.arrived?.(entry.box, m?.meta?.name, entry.foot);
      // the sim already sends the curious over for new characters (addActor) and new obstacles or
      // spots (setWorld); only a thing with neither needs it here, so nobody is called twice
      if (entry.foot && !entry.actors.length && !entry.obstacles.length && !entry.spots.length) brain?.inspect?.(entry.foot.x, entry.foot.z);
    }
    api.mood?.setWeather?.(file, entry.weather);
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
    api.mood?.setWeather?.(file, []);
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
      if (o.material) [].concat(o.material).forEach(m => { if (!m.map?.userData?.shared) m.map?.dispose(); m.dispose(); });
    });
    loaded.delete(file);
  }
  // where animals can go: tops of things to land or climb on, and the drawn water
  function places() {
    env.perches = [...loaded.values()].filter(e => e.foot && !e.heldBy && !e.portable?.carrier && e.foot.top > 0.3)
      .map(e => ({ x: e.foot.x, z: e.foot.z, top: e.foot.top, r: Math.min(e.foot.hx, e.foot.hz), foot: e.foot }));
    env.water = water.zones();
  }
  // footprints characters must not stand in (a jail holds its prisoner inside, so it isn't one)
  const blockingFeet = () => [...loaded.values()].filter(e => e.foot && !e.heldBy && !e.holds.length && !e.portable?.carrier).map(e => e.foot);
  function refreshWorld() {
    places();
    trees.length = 0;
    const spots = [];
    for (const e of loaded.values()) { ensurePortable(e); trees.push(...e.obstacles); spots.push(...e.spots); }
    brain.setWorld({ trees, spots, feet: blockingFeet() });
    brain.setHolds([...loaded.values()].flatMap(e => e.holds));
    attachHeld();
    brain.setThings(thingList());
  }
  // what the characters can talk about: every drawn thing, where it is, and when it arrived
  // (things there at page load count as old: at 0)
  function thingList() {
    const box = new THREE.Box3(), c = new THREE.Vector3();
    return [...loaded.entries()].map(([file, e]) => {
      box.setFromObject(e.box); box.getCenter(c);
      return { file, name: e.meta?.name || file.replace(/\.js$/, ''), x: c.x, z: c.z, at: e.at || 0,
        actors: e.actors.map(a => a.id), holds: e.holds.map(h => h.actor), heldBy: e.heldBy?.actor || null };
    });
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
  const later = [];
  for (const [, file] of listing.matchAll(/href="([\w.-]+\.js)"/g)) await loadThing(file, undefined, false, later);
  // everything is there now: place the new ones against all of it, then pull apart what overlaps
  for (const [file, entry, meta] of later) try { place(file, entry, meta, false); } catch (e) { report(`things/${file}: placing: ${e.message}`); }
  untangle();
  const actors = [...loaded.values()].flatMap(e => e.actors);
  for (const e of loaded.values()) { ensurePortable(e); trees.push(...e.obstacles); }
  const spots = [...loaded.values()].flatMap(e => e.spots);
  places();
  brain = sim.create({ THREE, actors, trees, pond, spots, feet: blockingFeet(), islandR: FIT_R, ground: GROUND, groundY, states: prevState, extra, moves });
  brain.setHolds([...loaded.values()].flatMap(e => e.holds));
  attachHeld();
  brain.setThings(thingList());

  return {
    // engine calls this when only things/ changed: reload just those files
    async reloadThings(changed, removed) {
      const states = brain.snapshot();
      const fresh = new Set(changed.filter(f => !loaded.has(f)));
      for (const f of [...changed, ...removed]) unloadThing(f);
      for (const f of removed) if (placed[f]) savePlace(f, null);
      for (const f of changed) await loadThing(f, states, fresh.has(f));
      untangle(new Set(changed));          // a new or rewritten thing that ended up in another's way moves
      refreshWorld();
    },
    snapshot: () => brain.snapshot(),
    // someone tapped (part of) a drawn thing: it wiggles, its lamps blink, and its own onTap() runs
    tapThing(obj) {
      for (const [file, e] of loaded) {
        let o = obj; while (o && o !== e.box) o = o.parent;
        if (!o) continue;
        // with the scales it had when loaded, and not while it is still growing in (status.arrived)
        if (!e.wiggle && clockNow - (e.bornAt ?? -9) > 0.8) e.wiggle = { at: clockNow, parts: e.base || e.box.children.map(c => [c, c.scale.clone()]) };
        api.mood?.blink?.(file);
        try { e.onTap?.(); } catch (err) { report(`things/${file}: onTap: ${err.message}`); }
        return file;
      }
      return null;
    },
    freeSpot: (x, z, r) => freeSpot(x, z, r),
    places: () => ({ perches: env.perches, water: env.water }),   // where animals land, climb and swim (for tests)
    box: file => loaded.get(file)?.box,    // a thing's group (for tests)
    feet: () => [...loaded].map(([f, e]) => ({ file: f, foot: e.foot, obstacles: e.obstacles, pinned: !!pinned(e) })),   // for tests   // for the light that shows where a drawing will appear
    brain: () => brain,                   // for UI in index.html (e.g. click a character); sim exposes its actors
    update(t, dt) {
      clockNow = t;
      island.update(t);
      water.tick(t);
      for (const e of loaded.values()) {
        if (e.wiggle) {                       // tapped: a squash-and-stretch wiggle, then back exactly
          const k = (t - e.wiggle.at) / 0.7;
          if (k >= 1) { for (const [o, s] of e.wiggle.parts) o.scale.copy(s); e.wiggle = null; }
          else { const w = Math.sin(k * Math.PI * 5) * 0.14 * (1 - k); for (const [o, s] of e.wiggle.parts) o.scale.set(s.x * (1 - w * 0.5), s.y * (1 + w), s.z * (1 - w * 0.5)); }
        }
        if (!e.update) continue;
        try { e.update(t, dt, env); } catch (err) { report('things: ' + err.message); e.update = null; }
      }
      let carriedChange = false;
      for (const e of loaded.values()) if (e.portable && e.foot && followPortable(e)) carriedChange = true;
      if (carriedChange) refreshWorld();      // picked up or put down: the grid, perches and paths see it now
      env.actors = brain.actors?.() || [];   // living props (e.g. a tree with a face) can react to who is near
      env.night = api.mood?.night ?? 0;      // 0 day … 1 night: characters get sleepy and gather at lamps
      env.lamps = api.mood?.lamps() ?? [];
      env.weather = api.mood?.weather?.() || {};   // rain, snow, rainbow, lightning (and its flash)
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


// ---------- preview: ?style=origami — every drawn thing as folded paper ----------
// few large facets (primitives rebuilt with few segments, everything flat-shaded), matte paper
// with a faint grain, and soft crease lines along the folds. Preview only: no thing has to cooperate.
// the look of drawn things: coloured pencil by default; ?look=plain|cutout|origami to compare
const STYLE = new URLSearchParams(location.search).get('look') || 'crayon';   // separate from ?style=paper, so both combine
const ORIGAMI = STYLE === 'origami';
let grain = null;
function paperGrain(THREE) {
  if (grain) return grain;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'), img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) { const v = 236 + Math.random() * 19; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  grain = new THREE.CanvasTexture(cv); grain.wrapS = grain.wrapT = THREE.RepeatWrapping; grain.repeat.set(3, 3);
  grain.userData.shared = true;
  grain.colorSpace = THREE.SRGBColorSpace;
  return grain;
}
function folded(THREE, geo) {
  const p = geo.parameters || {};
  switch (geo.type) {
    case 'SphereGeometry': return new THREE.SphereGeometry(p.radius, 7, 5, p.phiStart, p.phiLength, p.thetaStart, p.thetaLength);
    case 'CapsuleGeometry': return new THREE.CapsuleGeometry(p.radius, p.length, 2, 6);
    case 'CylinderGeometry': return new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, Math.min(p.radialSegments, 6), 1, p.openEnded);
    case 'ConeGeometry': return new THREE.ConeGeometry(p.radius, p.height, Math.min(p.radialSegments, 6), 1, p.openEnded);
    case 'TorusGeometry': return new THREE.TorusGeometry(p.radius, p.tube, 4, Math.min(p.tubularSegments, 10), p.arc);
    case 'LatheGeometry': return new THREE.LatheGeometry(p.points.filter((_, i, a) => i % 2 === 0 || i === a.length - 1), 7);
    default: return null;
  }
}
function origami(THREE, root) {
  const tex = paperGrain(THREE);
  const meshes = [];
  root.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.geometry && !o.userData.water) meshes.push(o); });
  for (const o of meshes) {
    const mats = [].concat(o.material);
    if (mats.some(m => m.transparent || m.isMeshBasicMaterial)) continue;   // water, glows, flames stay as they are
    const nu = folded(THREE, o.geometry);
    if (nu) { o.geometry.dispose(); o.geometry = nu; }
    const paper = m => new THREE.MeshStandardMaterial({ color: (m.color || new THREE.Color(0xffffff)).clone().lerp(new THREE.Color(0xfff8ec), 0.12),
      map: tex, flatShading: true, roughness: 0.95, metalness: 0, emissive: m.emissive?.clone?.() || 0x000000, emissiveIntensity: m.emissiveIntensity ?? 1 });
    o.material = Array.isArray(o.material) ? o.material.map(paper) : paper(o.material);
    const creases = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    creases.raycast = () => {};
    o.add(creases);
  }
}


// shared by the previews: the meshes a style may restyle (water, glows, flames, sprites stay)
function styleable(root) {
  const out = [];
  root.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.geometry && !o.userData.water && !o.userData.outline) out.push(o); });
  return out.filter(o => ![].concat(o.material).some(m => m.transparent || m.isMeshBasicMaterial));
}
// an outline shell: the mesh again, a little bigger, back faces only, in one colour
function shell(THREE, o, color, grow) {
  const m = new THREE.Mesh(o.geometry, new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }));
  m.userData.outline = true; m.raycast = () => {};
  m.onBeforeRender = () => { m.scale.setScalar(1 + grow / Math.max(0.15, o.geometry.boundingSphere?.radius || 0.5)); };
  o.geometry.computeBoundingSphere();
  o.add(m);
}
// three flat tones: printed card, not shiny plastic
let toon = null;
function toonRamp(THREE) {
  if (toon) return toon;
  toon = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  toon.minFilter = toon.magFilter = THREE.NearestFilter; toon.needsUpdate = true;
  return toon;
}

// ---------- preview: ?style=cutout — pop-up book cardboard: flat tones, a white cut edge, standing up ----------
function cutout(THREE, root) {
  const ramp = toonRamp(THREE), tex = paperGrain(THREE);
  for (const o of styleable(root)) {
    const card = m => new THREE.MeshToonMaterial({ color: (m.color || new THREE.Color(0xffffff)).clone().multiplyScalar(1.05), gradientMap: ramp, map: tex,
      emissive: m.emissive?.clone?.() || 0x000000, emissiveIntensity: m.emissiveIntensity ?? 1 });
    o.material = Array.isArray(o.material) ? o.material.map(card) : card(o.material);
    shell(THREE, o, 0xfffdf6, 0.045);              // the white edge where the scissors went round
  }
  // pressed flat front-to-back like a cardboard standee, so it reads as a cut-out, not a figure
  for (const c of root.children) c.scale.z *= 0.42;
}

// ---------- preview: ?style=crayon — things that look drawn with coloured pencil ----------
// a stroke texture per colour (diagonal pencil strokes with paper showing through) and a dark
// pencil outline. Stand-in for the child's real strokes from the frame.
let crayonTex = null;
function crayonStrokes(THREE) {
  if (crayonTex) return crayonTex;
  // grey pencil strokes on white: the material colour multiplies it, so one texture serves every colour
  const cv = document.createElement('canvas'); cv.width = cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 512);
  for (let pass = 0; pass < 2; pass++) {
    g.save(); g.translate(256, 256); g.rotate(pass ? -0.7 : 0.85); g.translate(-400, -400);
    for (let i = 0; i < 260; i++) {
      const y = i * 3.1 + Math.random() * 2, x0 = Math.random() * 60, len = 600 + Math.random() * 200;
      const v = Math.round(150 + Math.random() * 70);
      g.strokeStyle = `rgb(${v},${v},${v})`;
      g.globalAlpha = 0.35 + Math.random() * 0.45; g.lineWidth = 1.5 + Math.random() * 2.5;
      g.beginPath(); g.moveTo(x0, y);
      for (let x = x0; x < x0 + len; x += 40) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 1.6);
      g.stroke();
    }
    g.restore();
  }
  crayonTex = new THREE.CanvasTexture(cv); crayonTex.wrapS = crayonTex.wrapT = THREE.RepeatWrapping; crayonTex.repeat.set(2, 2);
  crayonTex.colorSpace = THREE.SRGBColorSpace; crayonTex.anisotropy = 8;
  crayonTex.userData.shared = true;               // used by every thing: never disposed with one of them
  return crayonTex;
}
function crayon(THREE, root) {
  for (const o of styleable(root)) {
    const drawn = m => new THREE.MeshStandardMaterial({ map: crayonStrokes(THREE), color: (m.color || new THREE.Color(0xffffff)).clone().lerp(new THREE.Color(0xffffff), 0.08), roughness: 1, metalness: 0,
      emissive: m.emissive?.clone?.() || 0x000000, emissiveIntensity: m.emissiveIntensity ?? 1 });
    o.material = Array.isArray(o.material) ? o.material.map(drawn) : drawn(o.material);
    shell(THREE, o, 0x2a2622, 0.03);               // the pencil line round the outside
  }
}
