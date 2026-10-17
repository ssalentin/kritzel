// Autonomous life on the island, driven by rot.js (ROguelike Toolkit):
//  - the island is a grid; trees are walls, the pond is water (only Sqichy swims)
//  - ROT.Scheduler.Speed decides whose turn it is (faster characters act more often)
//  - ROT.FOV lets characters only notice who they can actually see (trees block sight)
//  - ROT.Path.AStar walks them around obstacles
//  - each character has needs (energy, social), a fear level, traits and relationships,
//    and picks its next goal by utility; meeting someone triggers an interaction
//    whose outcome changes the relationship.
import * as ROT from 'rot-js';
import { sound } from './sound.js';
import { lang, pickLines } from './i18n.js';

const N = 41, C = 20, CELL = 0.45, TICK = 0.13;   // the grid reaches ±9: the whole book's pages

const LINES = {
  sun: { sqichy: ['He! Wer hat die Sonne geklaut?'], person: ['Brrr…', 'Nur eine Wolke!', 'Huch, dunkel!'] },
  rest: { sqichy: ['*blubbert leise*'], person: ['Puh, kurze Pause.', 'Zzz…', '*gähnt*'] },
  splash: { sqichy: ['Platsch!', 'Ahh, Wasser!'], person: ['Platsch!', 'Pfütze!', 'Hihi, nass!'] },
  scared: { person: ['Hilfe!', 'Bloß weg hier!', 'Iiieh!'] },
  birds: { sqichy: ['Vögel! Blubb!', 'Kommt runter, Vögel!'], person: ['Schau, Vögel!', 'Die fliegen ja tief!', 'Hallo, Vögel!'] },
  tagCaught: { person: ['Hab dich!', 'Erwischt!'] },
  night: { sqichy: ['Blubb… Nacht!'], person: ['Gute Nacht!', 'Es wird dunkel…', 'Schau, der Mond!'] },
  day: { sqichy: ['Blubb, Morgen!'], person: ['Guten Morgen!', 'Die Sonne ist da!'] },
  warm: { person: ['Schön warm hier.', 'Ahh, Licht!', 'Kommt alle ans Feuer!'] },
  tapped: { sqichy: ['Blubb! Hihi!', 'Hallo, du da!'], person: ['Hihi!', 'Hallo du!', 'Das kitzelt!', 'Huch, hallo!'] },
  rain: { sqichy: ['Regen! Blubb, herrlich!'], person: ['Es regnet!', 'Schnell, ins Trockene!', 'Pitsch, patsch!'] },
  snow: { sqichy: ['Blubb, kalt!'], person: ['Schnee!', 'Es schneit!', 'Brrr, Schneeflocken!'] },
  rainbow: { sqichy: ['Ein Regenbogen! Blubb!'], person: ['Ein Regenbogen!', 'Wie schön!', 'Juhu, Regenbogen!'] },
  flash: { sqichy: ['Blubb!'], person: ['Huch!', 'Ein Blitz!', 'Iiieh!'] },
};
// the same in English (i18n.js decides which one is spoken)
const LINES_EN = {
  sun: { sqichy: ['Hey! Who stole the sun?'], person: ['Brrr…', 'Just a cloud!', 'Whoa, dark!'] },
  rest: { sqichy: ['*bubbles quietly*'], person: ['Phew, a little break.', 'Zzz…', '*yawns*'] },
  splash: { sqichy: ['Splash!', 'Ahh, water!'], person: ['Splash!', 'Puddle!', 'Hehe, wet!'] },
  scared: { person: ['Help!', 'Get me out of here!', 'Eeek!'] },
  birds: { sqichy: ['Birds! Blub!', 'Come down, birds!'], person: ['Look, birds!', 'They\'re flying so low!', 'Hello, birds!'] },
  tagCaught: { person: ['Got you!', 'Caught you!'] },
  night: { sqichy: ['Blub… night!'], person: ['Good night!', 'It\'s getting dark…', 'Look, the moon!'] },
  day: { sqichy: ['Blub, morning!'], person: ['Good morning!', 'The sun is here!'] },
  warm: { person: ['Nice and warm here.', 'Ahh, light!', 'Everyone to the fire!'] },
  tapped: { sqichy: ['Blub! Hehe!', 'Hello, you!'], person: ['Hehe!', 'Hello, you!', 'That tickles!', 'Oh, hello!'] },
  rain: { sqichy: ['Rain! Blub, lovely!'], person: ['It\'s raining!', 'Quick, somewhere dry!', 'Pitter patter!'] },
  snow: { sqichy: ['Blub, cold!'], person: ['Snow!', 'It\'s snowing!', 'Brrr, snowflakes!'] },
  rainbow: { sqichy: ['A rainbow! Blub!'], person: ['A rainbow!', 'How pretty!', 'Yay, a rainbow!'] },
  flash: { sqichy: ['Blub!'], person: ['Whoa!', 'Lightning!', 'Eeek!'] },
};

export function create({ THREE, actors, trees, pond, spots = [], feet = [], islandR, ground = null, groundY = () => 0, states = null, seed = Date.now() % 100000, extra = null, moves = null }) {
  ROT.RNG.setSeed(seed);
  const R = () => ROT.RNG.getUniform();
  const MV = moves?.makeMoves({ THREE, ground, R: () => ROT.RNG.getUniform() });
  let envNow = { perches: [], water: [] };
  const pick = a => ROT.RNG.getItem(a);
  const toWorld = (x, y) => [(x - C) * CELL, (y - C) * CELL];
  const key = (x, y) => x + ',' + y;
  const gap = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2) * CELL;

  actors = actors.slice();               // the sim owns its list; things add/remove actors live
  // ---------- terrain (rebuilt when drawn things add or remove obstacles) ----------
  const terrain = new Map();
  let groundCells = [], waterCells = [];
  const fov = new ROT.FOV.PreciseShadowcasting((x, y) => terrain.has(key(x, y)));
  function rebuildTerrain() {
    terrain.clear();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const [wx, wz] = toWorld(x, y);
      // on the pages (book.js), a little in from the edge so nobody walks off; or the old round island
      if (ground ? Math.abs(wx) > ground.w / 2 - 0.35 || Math.abs(wz) > ground.d / 2 - 0.35 : Math.hypot(wx, wz) > islandR) continue;
      if (trees.some(t => Math.hypot(wx - t.x, wz - t.z) < t.r)) continue;
      if (feet.some(f => Math.abs(wx - f.x) < f.hx + 0.05 && Math.abs(wz - f.z) < f.hz + 0.05)) continue;   // never inside a thing
      terrain.set(key(x, y), Math.hypot(wx - pond.x, wz - pond.z) < pond.r - 0.2 ? 'water' : 'ground');
    }
    const cellsOf = kind => [...terrain].filter(([, v]) => v === kind).map(([k]) => k.split(',').map(Number));
    groundCells = cellsOf('ground'); waterCells = cellsOf('water');
    for (const a of actors) a._pass = null;
  }
  rebuildTerrain();

  const nearestCell = (wx, wz, self) => {
    let best = null, bd = 1e9;
    for (const [x, y] of groundCells) {
      if (self && (!passable(self)(x, y) || actors.some(o => o !== self && o.cell && gap(x, y, o.cell.x, o.cell.y) < self.radius + o.radius))) continue;   // big bodies must fit
      const [cx, cz] = toWorld(x, y);
      const d = Math.hypot(cx - wx, cz - wz);
      if (d < bd) { bd = d; best = { x, y }; }
    }
    return best;
  };

  // ---------- actors ----------
  // a body's footprint radius and height, measured from its rig's meshes (things it will hold are
  // attached after this, so they don't count): 0.85 of the larger half-extent, so arms and tails may
  // touch but bodies don't overlap
  function bodyOf(a) {
    const g = a.rig?.g;
    if (!g) return null;
    const rot = g.rotation.y, b = new THREE.Box3(), m = new THREE.Box3();
    g.rotation.y = 0; g.updateMatrixWorld(true);
    g.traverse(o => { if (o.isMesh && o.geometry) { o.geometry.computeBoundingBox(); b.union(m.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld)); } });
    g.rotation.y = rot; g.updateMatrixWorld(true);
    if (b.isEmpty()) return null;
    return { r: Math.min(1.2, Math.max(0.12, 0.85 * Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2)), h: b.max.y - b.min.y };
  }
  const byId = {};
  // st: optional saved state of this actor (kept across live reloads, so nobody resets)
  function initActor(a, st) {
    byId[a.id] = a;
    a.kind = a.rig.kind;
    a.speed ??= 1;
    a.traits = { curiosity: 0.6, sociable: 0.6, bravery: 0.5, loyalty: 0, ...a.traits };
    a.start ??= [0, 0];
    const body = bodyOf(a);              // its real size, from the rig as built (issue #19)
    a.radius ??= body?.r ?? (a.kind === 'squid' ? 0.85 : 0.08 + 0.32 * (a.rig.g.scale.x || 1));
    a.height = body?.h ?? 1.5;
    a.cell = nearestCell(...a.start, a);
    const [wx, wz] = toWorld(a.cell.x, a.cell.y);
    a.pos = new THREE.Vector3(wx, 0, wz);
    a.face = a.id === 'sqichy' ? -Math.PI / 2 : Math.PI / 2;
    a.goal = null; a.goalSince = 0;
    a.busyUntil = 0; a.anim = 'idle'; a.animStart = 0; a.animUntil = 0; a.partner = null;
    a.hidden = false; a.rig.g.visible = true;      // restored characters are always back in view
    a.energy = 0.7 + R() * 0.3; a.social = 0.6; a.fear = 0;
    a.lastMet = {}; a.sayUntil = 0; a.hunger = R() * 0.5;
    a.getSpeed = () => a.speed;
    a.move = ['walk', 'hop', 'crawl', 'fly', 'swim', 'climb'].includes(a.move) ? a.move : 'walk';   // how it moves (moves.js)
    a.alt = 0; a.mv = null;
    MV?.setup(a);
    if (st) {
      Object.assign(a, { energy: st.energy, social: st.social, fear: st.fear, hunger: st.hunger ?? a.hunger,
        lastMet: {}, calmUntil: 0, face: st.face ?? a.face });   // saved times are from the old clock: forget them
      const ok = passable(a);
      // the cell from the saved world position (grid cells can change between versions), else the saved cell
      const c = st.pos && nearestCell(st.pos[0], st.pos[1], a);
      if (c) a.cell = c; else if (st.cell && ok(st.cell.x, st.cell.y)) a.cell = st.cell;
      a.pos.set(st.pos?.[0] ?? a.pos.x, 0, st.pos?.[1] ?? a.pos.z);
      a.rig.g.rotation.y = a.face;
    }
  }
  for (const a of actors) initActor(a, states?.[a.id]);
  // starting relationships: companions love the wanderer, are a bit shy of the big squid;
  // Sqichy is friendly (it said HALLO!) but likes a practice duel with strangers
  for (const a of actors) {
    a.rel = {};
    for (const b of actors) if (a !== b) a.rel[b.id] = 0.1;
  }
  for (const k of ['tophat', 'spiky']) {
    if (!byId[k] || !byId.wanderer) continue;
    byId[k].rel.wanderer = 0.8; byId.wanderer.rel[k] = 0.8;
    if (byId.sqichy) byId[k].rel.sqichy = -0.2;
  }
  if (byId.tophat && byId.spiky) byId.tophat.rel.spiky = byId.spiky.rel.tophat = 0.6;
  // things can declare starting relationships and whom an actor is afraid of
  function declaredRelations() {
    for (const a of actors) {
      for (const [id, v] of Object.entries(a.relations || {})) if (byId[id] && !a._relSet?.[id]) a.rel[id] = v;
      for (const id of a.fears || []) if (byId[id] && !a._relSet?.[id]) a.rel[id] = Math.min(a.rel[id] ?? 0, -0.4);
    }
  }
  declaredRelations();
  // relationships that grew during play survive reloads
  for (const a of actors) if (states?.[a.id]?.rel) { Object.assign(a.rel, states[a.id].rel); a._relSet = { ...states[a.id].rel }; }

  const scheduler = new ROT.Scheduler.Speed();
  for (const a of actors) scheduler.add(a, true);

  // ---------- bodies don't overlap (issue #19) ----------
  // every frame, two bodies closer than their radii push apart smoothly. Who gives way: whoever is
  // walking somewhere (the smaller one more); held characters and those busy with someone else stay
  // put; partners nudge each other to a polite distance. One far above the other doesn't count.
  function give(a, other) {
    if (a.hold) return 0;
    if (now < (a.partnerUntil ?? 0)) return a.partner === other ? 1 : 0;
    if (now < a.busyUntil) return 0;
    return (a.goal ? 1 : 0.6) / Math.max(0.2, a.radius);
  }
  function separate(dt) {
    const k = Math.min(1, dt * 8);
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (a.hidden) continue;
      for (let j = i + 1; j < actors.length; j++) {
        const c = actors[j];
        if (c.hidden || Math.abs((a.alt || 0) - (c.alt || 0)) > 0.8 * Math.max(a.height || 1, c.height || 1)) continue;
        let dx = c.pos.x - a.pos.x, dz = c.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz), min = a.radius + c.radius;
        if (d >= min) continue;
        if (d < 1e-4) { dx = Math.cos(i + j); dz = Math.sin(i + j); } else { dx /= d; dz /= d; }
        const wa = give(a, c), wc = give(c, a);
        if (!wa && !wc) continue;
        const push = (min - d) * k, sa = wa / (wa + wc), sc = wc / (wa + wc);
        a.pos.x -= dx * push * sa; a.pos.z -= dz * push * sa;
        c.pos.x += dx * push * sc; c.pos.z += dz * push * sc;
      }
    }
  }

  // ---------- live changes from drawn things ----------
  function addActor(a, st) {
    actors.push(a);
    initActor(a, st);
    if (!st) X.inspect?.(a.pos.x, a.pos.z, a, api);   // a new drawing: the others come to look
    a.rel = {};
    for (const b of actors) if (b !== a) { a.rel[b.id] = 0.1; b.rel[a.id] ??= 0.1; }
    if (st?.rel) { Object.assign(a.rel, st.rel); a._relSet = { ...st.rel }; }
    declaredRelations();
    scheduler.add(a, true);
  }
  function removeActor(id) {
    const a = byId[id];
    if (!a) return;
    if (a.hidden && a.goal?.spot) a.goal.spot.occupants = Math.max(0, (a.goal.spot.occupants || 1) - 1);
    scheduler.remove(a);
    actors.splice(actors.indexOf(a), 1);
    delete byId[id];
    for (const o of actors) {
      if (o.goal?.target === a) o.goal = null;
      if (o.flee?.from === a) o.flee = null;
      if (o.partner === a) o.partner = null;
    }
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].a === a) pending.splice(i, 1);
  }
  function snapshotOf(a) {
    return { cell: a.cell, pos: [a.pos.x, a.pos.z], face: a.face, rel: a.rel, energy: a.energy, social: a.social,
      fear: a.fear, hunger: a.hunger, lastMet: a.lastMet, calmUntil: a.calmUntil };
  }

  let now = 0, acc = 0, prevCover = 0, prevBirds = false, nextTick = 0, coverNow = 0;
  let nightNow = 0, prevNight = null, lampsNow = [], prevWeather = {};     // 0 day … 1 night; drawn lamps and fires { x, z }
  const pending = [];
  let stage = null;                      // two characters in a dialogue { a, b, until }: others nearby keep quiet
  let thingsNow = [];                    // the drawn things (world.js): { name, file, x, z, at, actors, holds, heldBy }

  const say = (a, text, dur = 2.4, delay = 0) => pending.push({ a, text, at: now + delay, dur });
  const line = (a, group) => {
    const own = pickLines(a.lines?.[group]);     // a drawn character's own lines: array (German) or { de, en }
    if (own?.length) return pick(own);
    const L = lang() === 'en' ? LINES_EN : LINES;
    const pool = L[group]?.[a.kind === 'squid' ? 'sqichy' : 'person'] || L[group]?.person;
    return pool ? pick(pool) : '';
  };
  // bodies, not grid cells, must not overlap: every actor has a footprint radius (world units)
  const blocked = (x, y, a, ignore) =>
    actors.some(o => o !== a && o !== ignore && !o.hidden && gap(x, y, o.cell.x, o.cell.y) < a.radius + o.radius);
  const near = (a, b, extra = 0.35) => gap(a.cell.x, a.cell.y, b.cell.x, b.cell.y) <= a.radius + b.radius + extra;
  function passable(a) {
    if (!a._pass) {
      const ok = new Set();
      for (const [k, t] of terrain) {
        if (t === 'water' && !a.swims) continue;
        const [x, y] = k.split(',').map(Number);
        const [wx, wz] = toWorld(x, y);
        if (a.hold && Math.hypot(wx - a.hold.x, wz - a.hold.z) > a.hold.r) continue;   // held by a drawn thing (a jail, a fence)
        // wide bodies keep clear of tree trunks too
        if (trees.every(tr => Math.hypot(wx - tr.x, wz - tr.z) > tr.r + Math.max(0, a.radius - 0.25))) ok.add(k);
      }
      a._pass = (x, y) => ok.has(key(x, y));
    }
    return a._pass;
  }
  const dist = (a, b) => Math.max(Math.abs(a.cell.x - b.cell.x), Math.abs(a.cell.y - b.cell.y));
  const rel = (a, b) => a.rel[b.id] ?? 0;
  const bond = (a, b, d) => {
    a.rel[b.id] = Math.max(-1, Math.min(1, rel(a, b) + d));
    b.rel[a.id] = Math.max(-1, Math.min(1, rel(b, a) + d));
  };

  function stepToward(a, tx, ty, target = null) {
    const pass = passable(a);
    const astar = new ROT.Path.AStar(tx, ty,
      (x, y) => (x === a.cell.x && y === a.cell.y) || (x === tx && y === ty) || (pass(x, y) && !blocked(x, y, a, target)),
      { topology: 8 });
    const path = [];
    astar.compute(a.cell.x, a.cell.y, (x, y) => path.push([x, y]));
    if (path.length < 2) return false;
    const [nx, ny] = path[1];
    if (!pass(nx, ny) || blocked(nx, ny, a)) return !!target;   // someone in the way: wait a moment
    a.cell = { x: nx, y: ny };
    return true;
  }

  function stepAway(a, from) {
    const pass = passable(a);
    let best = null, bd = dist(a, from);
    for (const [dx, dy] of ROT.DIRS[8]) {
      const x = a.cell.x + dx, y = a.cell.y + dy;
      if (!pass(x, y) || blocked(x, y, a)) continue;
      const d = Math.max(Math.abs(x - from.cell.x), Math.abs(y - from.cell.y)) + R() * 0.5;
      if (d > bd) { bd = d; best = { x, y }; }
    }
    if (best) a.cell = best;
    return !!best;
  }

  function visible(a) {
    const seen = [];
    fov.compute(a.cell.x, a.cell.y, 12, (x, y) => {
      for (const o of actors) if (o !== a && !o.hidden && o.cell.x === x && o.cell.y === y) seen.push(o);
    });
    return seen;
  }

  function decide(a) {
    const opts = [];
    const add = (u, goal) => opts.push({ u: u + R() * 0.3, goal });
    add(0.3 + a.traits.curiosity * 0.35, { type: 'wander', cell: pick(groundCells) });
    if (a.energy < 0.3 + 0.3 * nightNow) add(1.3 - a.energy + nightNow * 0.3, { type: 'rest', until: now + 20 + nightNow * 20 });   // sleepy at night
    // in the dark, a lamp or fire draws everyone close
    if (nightNow > 0.25 && lampsNow.length) {
      const l = pick(lampsNow), ang = R() * Math.PI * 2, r = 0.9 + R() * 0.7;
      const c = nearestCell(l.x + Math.cos(ang) * r, l.z + Math.sin(ang) * r, a);
      if (c) add(0.3 + nightNow * (0.5 + a.traits.sociable * 0.5), { type: 'warm', cell: [c.x, c.y], lamp: l, until: now + 12 + R() * 10 });
    }
    // doors (drawn houses): go in to rest for a while; more often when tired or under clouds
    X.options?.(a, add, api);                 // doors and items: see sim-extra.js
    for (const sp of spots) if (sp.kind === 'egg' && !sp.found && spotCell(sp, a)) add(0.4 + a.traits.curiosity * 0.4, { type: 'eat', spot: sp, cell: spotCell(sp, a) });
    // food from drawn things (e.g. the apple tree): go there when hungry
    for (const sp of spots) if (sp.kind === 'food' && a.hunger > 0.5)
      add(0.6 + a.hunger, { type: 'eat', spot: sp, cell: spotCell(sp, a) });
    // sometimes just stand around and look about
    add(0.25 + (1 - a.traits.curiosity) * 0.2, { type: 'idle', until: now + 1.5 + R() * 2.5 });
    if (a.swims && waterCells.length) add(0.35 + (1 - a.energy) * 0.3, { type: 'swim', cell: pick(waterCells) });
    for (const o of visible(a)) {
      const r = rel(a, o);
      // afraid of it and it's close: run! (fear fades as they get to know each other)
      if (a.fears?.includes(o.id) && rel(a, o) < 0.45 && dist(a, o) < 6 && now > (a.calmUntil ?? 0)) {
        add(2.5, { type: 'flee', target: o, until: now + 2.5 + R() * 1.5 });
        a.calmUntil = now + 12;          // after a dash, stand and peek for a while (lets the other catch up)
        if (R() < 0.5) say(a, line(a, 'scared'), 1.6);
        continue;
      }
      if (now - (a.lastMet[o.id] ?? -99) < 10) continue;     // just talked; give it a rest
      if (a.fear > 0.45 && r < 0.2) add(a.fear + 0.5, { type: 'flee', target: o, until: now + 3 });
      else add(0.35 + a.social * a.traits.sociable * (0.8 + r) + (a.kind === 'squid' ? 0.3 : 0), { type: 'approach', target: o });
    }
    if (a.leader) {
      const L = byId[a.leader];
      if (L && dist(a, L) > 2) add(0.45 + a.traits.loyalty, { type: 'follow', target: L });
    }
    opts.sort((p, q) => q.u - p.u);
    a.goal = opts[0].goal;
    a.goalSince = now;
    if (a.goal.type === 'rest') say(a, line(a, 'rest'), 2);
  }

  // a free walkable cell close to a spot (spots usually sit on an obstacle like a trunk)
  function spotCell(sp, a) {
    let best = null, bd = 1e9;
    const pass = passable(a);
    for (const [x, y] of groundCells) {
      if (!pass(x, y)) continue;
      const [wx, wz] = toWorld(x, y);
      const d = Math.abs(Math.hypot(wx - sp.x, wz - sp.z) - 1.0) + R() * 0.3;
      if (d < bd) { bd = d; best = [x, y]; }
    }
    return best;
  }

  function busy(a, partner, anim, dur) {
    a.partner = partner; a.anim = anim; a.animStart = now; a.animUntil = now + dur; a.busyUntil = now + dur;
    a.partnerUntil = partner ? now + dur : 0;   // the moment with this partner ends here, whatever else keeps it busy
    a.goal = null;
  }

  const X = extra || {};
  Object.assign(LINES, X.LINES);
  Object.assign(LINES_EN, X.LINES_EN);
  // what extra interactions get: the sim's helpers, so they stay generic
  const stageFor = (a, b, until) => { stage = { a, b, until }; };
  const talking = () => (stage && now < stage.until ? stage : null);
  const api = { stage: stageFor, talking, things: () => thingsNow, night: () => nightNow, lamps: () => lampsNow, byId: () => byId, busy, say, line, bond, now: () => now, R, pick, rel, actors: () => actors, nearest: nearestCell, step: stepToward, pass: passable, spots: () => spots, spotCell, cover: () => coverNow, seen: (x, y) => { const c = new Set(); fov.compute(x, y, 12, (cx, cy) => c.add(cx + ',' + cy)); return c; } };
  const INT = Object.fromEntries(Object.entries(X.INTERACTIONS || {}).map(([k, f]) => [k, (a, b) => f(a, b, api)]));

  function interact(a, b) {
    a.lastMet[b.id] = b.lastMet[a.id] = now;
    const r = Math.min(rel(a, b), rel(b, a));
    if (X.choose) INT[X.choose(a, b, r, api)](a, b);   // without sim-extra.js people just wander
  }

  function act(a) {
    if (MV?.special(a, envNow)) return;        // flies, swims or climbs: moves.js runs it, off the grid
    a.energy = Math.max(0, a.energy - 0.004 * (1 + nightNow));   // night makes everyone tired sooner
    a.hunger = Math.min(1, a.hunger + 0.003);
    a.social = Math.min(1, a.social + 0.007);
    a.fear = Math.max(0, a.fear - 0.008);
    if (now < a.busyUntil) return;
    a.partner = null;

    // being chased in a game of tag
    if (a.flee && now < a.flee.until) { if (!X.hide?.(a, a.flee.from, api)) stepAway(a, a.flee.from); return; }
    a.flee = null;

    if (!a.goal || (now - a.goalSince > 15 && !/visit|fetch|bring/.test(a.goal.type))) decide(a);
    const g = a.goal;
    switch (g.type) {
      case 'wander':
      case 'swim': {
        const wasDry = terrain.get(key(a.cell.x, a.cell.y)) !== 'water';
        if ((a.cell.x === g.cell[0] && a.cell.y === g.cell[1]) || !stepToward(a, g.cell[0], g.cell[1])) a.goal = null;
        if (g.type === 'swim' && wasDry && terrain.get(key(a.cell.x, a.cell.y)) === 'water') say(a, line(a, 'splash'), 1.6);
        break;
      }
      case 'rest':
        a.energy += 0.016;
        if (a.energy >= 0.8 || now > g.until) { a.goal = null; }   // rested enough: back to the world (keeps rests to about a fifth of the time)
        break;
      case 'eat': {
        const [sx, sz] = toWorld(a.cell.x, a.cell.y);
        if (Math.hypot(sx - g.spot.x, sz - g.spot.z) < 1.4) {
          busy(a, null, 'talk', 2.6);
          a.face = Math.atan2(g.spot.x - sx, g.spot.z - sz);
          say(a, pick(pickLines(g.spot.lines) || ['Mmh!']), 2.2); sound.at(a.rig.g).mampf();
          if (g.spot.kind === 'egg') { g.spot.found = true; a.eggs = (a.eggs || 0) + 1; } else { a.hunger = 0; a.energy = Math.min(1, a.energy + 0.35); }
        } else if (!stepToward(a, g.cell[0], g.cell[1])) a.goal = null;
        break;
      }
      case 'warm': {                       // walk to the light, then sit by it a while
        if (now > g.until) { a.goal = null; break; }
        const there = a.cell.x === g.cell[0] && a.cell.y === g.cell[1];
        if (!there && !stepToward(a, g.cell[0], g.cell[1])) { a.goal = null; break; }
        if (there && !g.sat) { g.sat = true; const [sx, sz] = toWorld(a.cell.x, a.cell.y); a.face = Math.atan2(g.lamp.x - sx, g.lamp.z - sz); if (R() < 0.3) say(a, line(a, 'warm'), 2); }
        if (there) a.energy = Math.min(1, a.energy + 0.006);
        break;
      }
      case 'idle':
        a.energy = Math.min(1, a.energy + 0.004);
        if (R() < 0.02) { a.anim = pick(['lookup', 'wave', 'yawn', 'stretch']); a.animStart = now; a.animUntil = now + 1.8; }   // fidget
        if (now > g.until) a.goal = null;
        break;
      case 'circle':                       // stand on a ring around the group's middle, then dance
        if (now > g.until) { a.goal = null; break; }
        if (a.cell.x === g.cell[0] && a.cell.y === g.cell[1]) { a.anim = 'dance'; a.animStart = now; a.animUntil = now + 0.3; }
        else if (!stepToward(a, g.cell[0], g.cell[1])) a.goal = null;
        break;
      case 'follow':
        if (near(a, g.target, 1.2) || !stepToward(a, g.target.cell.x, g.target.cell.y, g.target)) a.goal = null;
        break;
      case 'flee':
        if (now > g.until || !stepAway(a, g.target)) a.goal = null;
        break;
      case 'visit': case 'fetch': case 'bring': X.visit?.(a, g, api); break;
      case 'pick': case 'carry': case 'give': X.portable?.(a, g, api); break;
      case 'approach':
        if (g.target.hidden) { a.goal = null; break; }
        if (near(a, g.target, 0.9)) { interact(a, g.target); }   // wider margin: two bodies waiting on each other would deadlock
        else if (!stepToward(a, g.target.cell.x, g.target.cell.y, g.target)) a.goal = null;
        break;
      case 'chase': {
        const prey = g.target;
        if (now > g.until) { a.goal = null; prey.flee = null; break; }
        if (near(a, prey)) {
          say(a, line(a, 'tagCaught'), 1.4);
          prey.flee = null;
          a.lastMet[prey.id] = prey.lastMet[a.id] = now;
          bond(a, prey, 0.05);
          if (g.rounds > 1) {              // roles swap: the caught one now chases
            prey.goal = { type: 'chase', target: a, until: now + 8, rounds: g.rounds - 1 };
            prey.busyUntil = now + 1;
            a.flee = { from: prey, until: now + 8 };
            a.goal = null;
          } else { busy(a, prey, 'dance', 2); busy(prey, a, 'dance', 2); }
        } else stepToward(a, prey.cell.x, prey.cell.y, prey);
        break;
      }
    }
  }

  // ---------- per-frame animation ----------
  const lerpAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

  function animPerson(a, state, t, moving) {
    const r = a.rig, ph = t + a.speed * 3;
    for (const p of [r.armL, r.armR, r.legL, r.legR]) p.rotation.set(0, 0, 0);
    r.head.rotation.set(0, 0, 0);
    r.body.position.y = 0; r.g.position.y = 0;
    const k = (now - a.animStart);
    switch (state) {
      case 'walk': {
        const s = Math.sin(ph * 9 * a.speed) * 0.7;
        r.legL.rotation.x = s; r.legR.rotation.x = -s; r.armL.rotation.x = -s * 0.8; r.armR.rotation.x = s * 0.8;
        r.g.position.y = Math.abs(Math.cos(ph * 9 * a.speed)) * 0.05;
        break;
      }
      case 'sit':
        r.legL.rotation.x = r.legR.rotation.x = -1.5;
        r.g.position.y = -0.62 * r.g.scale.y;
        r.head.rotation.x = 0.25 + Math.sin(t * 1.5) * 0.05;
        break;
      case 'wave': r.armR.rotation.z = -2.5 + Math.sin(t * 12) * 0.35; break;
      case 'talk':
        r.armR.rotation.x = -0.9 + Math.sin(t * 5) * 0.3; r.armL.rotation.x = -0.5 + Math.sin(t * 4 + 1) * 0.2;
        r.head.rotation.z = Math.sin(t * 3) * 0.1;
        break;
      case 'scared':
        r.armL.rotation.z = 2.4; r.armR.rotation.z = -2.4;
        r.g.position.y = Math.sin(Math.min(1, k / 0.8) * Math.PI) * 0.5;
        r.body.position.y = Math.sin(t * 40) * 0.02;
        break;
      case 'dance':
        r.g.position.y = Math.abs(Math.sin(t * 7)) * 0.4;
        r.armL.rotation.z = 2.6 + Math.sin(t * 7) * 0.3; r.armR.rotation.z = -2.6 - Math.sin(t * 7) * 0.3;
        break;
      case 'highfive': r.armR.rotation.x = -2.9; break;
      case 'splash':                       // a little hop into the puddle
        r.g.position.y = Math.abs(Math.sin((t - a.animStart) * 7)) * 0.25;
        r.armL.rotation.z = 1.2; r.armR.rotation.z = -1.2;
        break;
      case 'yawn': r.head.rotation.x = -0.35; r.armR.rotation.x = -1.6; break;             // hand to the mouth
      case 'stretch': r.armL.rotation.z = 2.5; r.armR.rotation.z = -2.5; r.body.position.y = 0.04; break;
      case 'lookup': r.head.rotation.x = -0.6; break;
      default:
        r.armL.rotation.z = 0.08 + Math.sin(t * 1.6) * 0.04; r.armR.rotation.z = -0.08 - Math.sin(t * 1.6) * 0.04;
    }
  }

  function animSquid(a, state, t, moving) {
    const r = a.rig;
    const inWater = terrain.get(key(a.cell.x, a.cell.y)) === 'water';
    let swing = -0.25, mouth = 0.6, hop = 0;
    const k = (now - a.animStart) / Math.max(0.1, a.animUntil - a.animStart);
    switch (state) {
      case 'swing':
        swing = k < 0.3 ? -0.25 - k / 0.3 * 0.7 : k < 0.5 ? -0.95 + (k - 0.3) / 0.2 * 2.4 : 1.45 - (k - 0.5) * 3.4;
        mouth = 1.5; hop = Math.abs(Math.sin(k * Math.PI * 2)) * 0.25;
        break;
      case 'wave': swing = -0.6 + Math.sin(t * 10) * 0.4; mouth = 1.3; break;
      case 'talk': mouth = 0.6 + Math.abs(Math.sin(t * 9)) * 0.9; break;
      case 'dance': hop = Math.abs(Math.sin(t * 6)) * 0.4; swing = -0.4 + Math.sin(t * 6) * 0.4; mouth = 1.1; break;
      case 'highfive': swing = -1.2; mouth = 1.2; break;
      case 'lookup': mouth = 1.6; break;
      case 'sit': mouth = 0.25; break;
    }
    const sink = inWater ? -0.7 : 0;
    r.g.position.y += ((sink + hop + Math.sin(t * (moving ? 6 : 2)) * 0.06) - r.g.position.y) * 0.25;
    r.body.scale.y = 0.95 + Math.sin(t * 2) * 0.03;
    r.mouth.scale.y = mouth * (0.8 + Math.abs(Math.sin(t * 10)) * 0.4);
    const blink = (t % 3.7) < 0.12 || state === 'sit' ? 0.15 : 1;
    for (const e of r.eyes) e.scale.y = blink;
    r.swordArm.rotation.x = swing;
    r.swordArm.rotation.z = 0.5;
    for (const tf of r.tufts) tf.rotation.z = Math.sin(t * 5 + tf.position.x * 8) * 0.25;
    for (const { segs, phase } of r.tentacles)
      segs.forEach((s, i) => { s.rotation.x = 0.35 + Math.sin(t * (moving ? 7 : 3) + phase + i * 0.7) * (0.15 + i * 0.08); });
  }

  return {
    addActor, removeActor,
    actors: () => actors, byId: () => byId, spots: () => spots,   // read-only views for the UI and tests
    // obstacles/spots changed (a drawn thing was added, changed or removed)
    setWorld({ trees: tr, spots: sp, feet: ft = feet }) {
      feet = ft;
      const had = new Set([...trees, ...spots].map(o => o.x + ',' + o.z));
      const fresh = [...tr, ...sp].filter(o => !had.has(o.x + ',' + o.z));
      trees = tr; spots = sp;
      for (const o of fresh.slice(0, 1)) X.inspect?.(o.x, o.z, null, api);
      rebuildTerrain();
      for (const a of actors) {
        if (!passable(a)(a.cell.x, a.cell.y)) { const [wx, wz] = toWorld(a.cell.x, a.cell.y); a.cell = nearestCell(wx, wz, a); }
        if ([a.goal?.spot, a.goal?.item, a.goal?.lock].some(s => s && !spots.includes(s))) { a.goal = null; a.hidden = false; a.rig.g.visible = true; }   // target gone: forget it
      }
    },
    // drawn things that hold actors (a jail around the spider): [{ actor: id, x, z, r }]; the actor only
    // walks inside its circle and is brought in if it is outside. Actors no longer held walk free again.
    // something new appeared at (x, z): curious characters nearby go and look
    inspect(x, z) { X.inspect?.(x, z, null, api); },
    // someone tapped this character: a little jump, a giggle and hello
    tap(a) {
      if (!a || a.hidden) return;
      a.jumpAt = now; a.fear = Math.max(0, a.fear - 0.2);
      a.anim = 'wave'; a.animStart = now; a.animUntil = a.busyUntil = now + 1.2;
      pending.splice(0, pending.length, ...pending.filter(p => p.a !== a));
      say(a, line(a, 'tapped'), 1.8);
    },
    setThings(list) { thingsNow = list; },
    setHolds(list) {
      for (const a of actors) {
        const h = list.find(x => x.actor === a.id) || null;
        if (JSON.stringify(h) === JSON.stringify(a.hold || null)) continue;
        a.hold = h; a._pass = null;
        if (h && Math.hypot(a.pos.x - h.x, a.pos.z - h.z) > h.r) {
          a.goal = null; a.hidden = false; a.rig.g.visible = true;
          a.cell = nearestCell(h.x, h.z, a) || a.cell;
          const [wx, wz] = toWorld(a.cell.x, a.cell.y);
          a.pos.set(wx, 0, wz);
        }
      }
    },
    snapshot() { return Object.fromEntries(actors.map(a => [a.id, snapshotOf(a)])); },
    update(t, dt, { cover = 0, birdsLow = false, night = 0, lamps = [], weather = {}, perches = [], water = [] } = {}) {
      envNow = { perches, water };
      now = t; nightNow = night; lampsNow = lamps;
      // a storm sends everyone in through a door; rain only now and then (they'd rather splash)
      coverNow = Math.max(cover, weather.lightning ? 1 : weather.rain ? 0.4 : 0);
      if (weather.rain) for (const a of actors) {
        if (a.hidden || now < a.busyUntil || R() > dt * 0.12) continue;            // about every 8 s each
        a.anim = 'splash'; a.animStart = now; a.animUntil = a.busyUntil = now + 0.9;
        if (R() < 0.4) say(a, line(a, 'splash'), 1.4);
      }
      acc += dt;
      while (acc >= TICK) { acc -= TICK; const a = scheduler.next(); if (a) act(a); }   // empty world: nobody to act
      if (X.tick && now >= (nextTick ?? 0)) { nextTick = now + 4; X.tick(actors, api, coverNow); }

      // the cloud just covered the sun: everyone reacts
      if (cover > 0.6 && prevCover <= 0.6) {
        for (const a of actors) {
          if (now < a.busyUntil) continue;
          a.anim = 'lookup'; a.animStart = now; a.animUntil = a.busyUntil = now + 2;
          if (a.kind === 'squid' || R() < 0.6) say(a, line(a, 'sun'), 2, R() * 0.6);
        }
      }
      prevCover = cover;

      // the birds swoop down low: whoever is free looks up and points it out
      if (birdsLow && !prevBirds) {
        for (const a of actors) {
          if (now < a.busyUntil) continue;
          a.anim = 'lookup'; a.animStart = now; a.animUntil = a.busyUntil = now + 2.2;
          if (R() < 0.7) say(a, line(a, 'birds'), 2, R() * 0.8);
        }
      }
      prevBirds = birdsLow;

      // drawn weather: everyone notices it starting; a rainbow is cheered; lightning scares them
      for (const kind of ['rain', 'snow', 'rainbow']) {
        if (weather[kind] && !prevWeather[kind]) for (const a of actors) {
          if (now < a.busyUntil) continue;
          a.anim = kind === 'rainbow' ? 'wave' : 'lookup'; a.animStart = now; a.animUntil = a.busyUntil = now + 2.2;
          if (kind === 'rainbow' || R() < 0.6) say(a, line(a, kind), 2.2, R() * 1.2);
        }
      }
      if (weather.flash > 0.9 && (prevWeather.flash || 0) <= 0.9) for (const a of actors) {
        a.fear = Math.min(1, a.fear + 0.35);
        if (now < a.busyUntil) continue;
        a.anim = 'lookup'; a.animStart = now; a.animUntil = a.busyUntil = now + 1.2;
        if (R() < 0.5) say(a, line(a, 'flash'), 1.6, R() * 0.4);
      }
      prevWeather = { ...weather };

      // night falls or the sun comes up: whoever is free looks up and says so
      const phase = night > 0.6 ? 'night' : night < 0.1 ? 'day' : prevNight;
      if (prevNight && phase !== prevNight) {
        for (const a of actors) {
          if (now < a.busyUntil) continue;
          a.anim = phase === 'night' ? 'yawn' : 'stretch'; a.animStart = now; a.animUntil = a.busyUntil = now + 2;
          if (R() < 0.6) say(a, line(a, phase), 2.2, R() * 1.2);
        }
      }
      prevNight = phase ?? (night > 0.35 ? 'night' : 'day');

      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (now < p.at) continue;
        pending.splice(i, 1);
        // a dialogue is on: nobody next to the two talks over them
        if (stage && now < stage.until && p.a !== stage.a && p.a !== stage.b &&
          Math.hypot(p.a.pos.x - (stage.a.pos.x + stage.b.pos.x) / 2, p.a.pos.z - (stage.a.pos.z + stage.b.pos.z) / 2) < 3.5) continue;
        p.a.rig.say(p.text); p.a.sayUntil = now + p.dur;
      }

      separate(dt);
      for (const a of actors) {
        if (a.sayUntil && now > a.sayUntil) { a.rig.say(''); a.sayUntil = 0; }
        let moving;
        // in a dialogue (or another moment with a partner): stay put and keep facing them until it ends
        const withPartner = now < (a.partnerUntil ?? 0) && a.partner && !a.partner.hidden;
        if (withPartner) {
          moving = false;
          a.face = Math.atan2(a.partner.pos.x - a.pos.x, a.partner.pos.z - a.pos.z);
        } else if (MV?.special(a, envNow)) {      // flying, swimming, climbing (moves.js)
          moving = MV.update(a, dt, now, envNow);
          if ((a._cellAt ?? -1) < now - 1) { a._cellAt = now; a.cell = nearestCell(a.pos.x, a.pos.z) || a.cell; }   // so others can find it
        } else {
          const [wx, wz] = toWorld(a.cell.x, a.cell.y);
          const dx = wx - a.pos.x, dz = wz - a.pos.z, d = Math.hypot(dx, dz);
          const step = Math.min(d, 1.6 * a.speed * (MV ? (moves.SPEED[a.move] ?? 1) : 1) * dt * (a.kind === 'squid' ? 1.2 : 1));
          moving = d > 0.03;
          if (moving) {
            // steer around anyone in the way instead of walking through them
            const fx = dx / d, fz = dz / d, px = -fz, pz = fx;     // forward, and its left
            let ux = fx, uz = fz;
            for (const o of actors) {
              if (o === a || o.hidden || Math.abs((o.alt || 0) - (a.alt || 0)) > 1) continue;
              const rx = o.pos.x - a.pos.x, rz = o.pos.z - a.pos.z, along = rx * fx + rz * fz, side = rx * px + rz * pz;
              const room = a.radius + o.radius + 0.1, ahead = room + 0.8;
              if (along > 0 && along < ahead && Math.abs(side) < room) {
                const k = (1 - along / ahead) * (1 - Math.abs(side) / room) * 1.5;
                const away = side > 0 ? -1 : 1;                     // it's on our left: go right, and back
                ux += px * away * k; uz += pz * away * k;
              }
            }
            const n = Math.hypot(ux, uz) || 1; ux /= n; uz /= n;
            a.pos.x += ux * step; a.pos.z += uz * step; a.face = Math.atan2(ux, uz);
          }
          else if (a.partner) a.face = Math.atan2(a.partner.pos.x - a.pos.x, a.partner.pos.z - a.pos.z);
          a.alt = a.move === 'hop' && moving ? Math.abs(Math.sin(now * 8 * a.speed)) * 0.3 : 0;   // hoppers bounce along
        }
        const j = now - (a.jumpAt ?? -9);       // tapped: one hop on the lift, under whatever animate() does
        if (a.lift) a.lift.position.y = groundY(a.pos.x) + a.alt + (j < 0.6 ? Math.sin(j / 0.6 * Math.PI) * 0.6 : 0);
        a.rig.g.position.x = a.pos.x;
        a.rig.g.position.z = a.pos.z;
        a.rig.g.rotation.y = lerpAngle(a.rig.g.rotation.y, a.face, Math.min(1, dt * 8));
        const state = now < a.animUntil ? a.anim : moving ? 'walk' : /rest|warm/.test(a.goal?.type) ? 'sit' : 'idle';
        if (a.rig.animate) a.rig.animate(state, t, moving, a);
        else if (a.kind === 'squid') animSquid(a, state, t, moving); else animPerson(a, state, t, moving);
      }
    },
  };
}
