// Extra speech lines and interactions for sim.js (hot-reloaded; sim.js gets this module as `extra`).
// Each interaction runs as fn(a, b, api) with api = { busy, say, line, bond, now(), R, pick, rel }.
// choose(a, b, r, api) picks the interaction for a pair that just met (r = their lower relationship).

import { sound } from './sound.js';

export const LINES = {
  greet: {
    sqichy: ['HALLO!', 'Hallo hallo!', 'Willkommen an meinem Teich!', 'Blubb! Hallo!'],
    person: ['Hallo!', 'Hi!', 'Hey, Sqichy!', 'Schöner Hut!', 'Servus!'],
  },
  chat: {
    sqichy: ['Willst du mein Schwert sehen?', 'Der Teich ist heute warm.', 'Ich bin ein Ritter, weißt du.', 'Blubb blubb.', 'Mein Hut hat Federn!'],
    person: ['Was für ein schöner Tag!', 'Schau mal, Blumen!', 'Wo gehen wir hin?', 'Ich hab Hunger.', 'Hast du die Wolke gesehen?', 'Die Insel ist winzig!'],
  },
  reply: {
    sqichy: ['Genau! Blubb.', 'Haha! Hallo!', 'Sehr wahr.', '*wackelt fröhlich*'],
    person: ['Ja!', 'Haha, stimmt!', 'Total.', 'Echt jetzt?', 'Cool!'],
  },
  spar: { sqichy: ['En garde!', 'Übungskampf!', 'Hyaaa!'], person: ['Huch!', 'Iiieh!', 'Nicht der Hut!', 'Langsam!'] },
  dance: { sqichy: ['Blubb blubb blubb!', 'Tanz mit mir!'], person: ['Juhu!', 'Juchhe!', 'Party!'] },
  highfive: { sqichy: ['Tentakel-Five!'], person: ['Gib mir fünf!', 'Jaaa!'] },
  tagStart: { person: ['Fangen! Du bist dran!', 'Fang mich doch!'] },
  comfort: { sqichy: ['Keine Angst, ich bin da!', 'Blubb, alles gut!'], person: ['Keine Angst, ich bin da!', 'Hey, alles gut, komm her.'] },
  thanks: { person: ['Danke…', 'Puh, okay.', 'Danke, du bist lieb.'] },
  spook: { person: ['Buh!', 'Hab keine Angst!', 'Ich tu dir nichts!'] },
  gossipGood: { person: ['Psst… der ist echt nett, weißt du.', 'Ich mag den total!'] },
  gossipBad: { person: ['Psst… ich trau dem nicht.', 'Hm, pass lieber auf bei dem.'] },
  sorry: { sqichy: ['Sorry, war nur Spaß!', 'Nicht böse sein, ja?'] },
  forgive: { person: ['Schon gut!', 'Alles gut, Sqichy.', 'Halb so wild!'] },
  group: { person: ['Wir tanzen im Kreis!', 'Eins, zwei, drei!', 'La la la!'] },
  share: { person: ['Hier, nimm einen Happen!', 'Ich hab noch was für dich!'] },
  thanksFood: { person: ['Mmh, danke!', 'Lecker!', 'Du bist der Beste!'] },
  recall_spook: { person: ['Weißt du noch, als du mich erschreckt hast?', 'Hihi, dein Buh damals!'] },
  recall_comfort: { person: ['Weißt du noch, als du mich getröstet hast?', 'Danke nochmal wegen damals!'] },
  enter: { person: ['Ich geh mal rein!', 'Kurz rein zum Ausruhen!'], sqichy: ['Ich geh mal rein!'] },
  back: { person: ['Bin wieder da!', 'Puh, frische Luft!'], sqichy: ['Bin wieder da!'] },
  knock: { person: ['Klopf klopf!', 'Hallo, bist du da?'], sqichy: ['Klopf klopf!'] },
  clear: { person: ['Die Sonne kommt wieder!', 'Endlich wieder hell!'], sqichy: ['Die Sonne! Blubb!'] },
  showEgg: { person: ['Schau mal, mein Ei!', 'Guck, ein Ei!'], sqichy: ['Schau, mein Ei!'] },
  found: { person: ['Oh, ein Schlüssel!', 'Hihi, ein Schlüssel!'] },
  open: { person: ['Ich schließ die Truhe auf!'] },
  treasure: { person: ['Ein Schatz!', 'Juhu, ein Schatz!'], sqichy: ['Blubb, ein Schatz!'] },
  startled: { person: ['Huch! Wer war das?', 'Uiii!'], sqichy: ['Blubb!'] },
  paidBack: { person: ['Keine Angst, ich bin da, so wie du damals!', 'Jetzt helf ich dir!'] },
  makeup: { person: ['Schwamm drüber, wir sind wieder Freunde!', 'Komm, tanzen wir zusammen!'] },
  brave: { person: ['Ich hab keine Angst mehr vor dir!', 'Jetzt bin ich mutig!'], sqichy: ['Keine Angst mehr! Blubb!'] },
  look: { person: ['Schau mal, das da!', 'Oh, was ist das?'], sqichy: ['Blubb, was ist das?'] },
  think: { person: ['Hmm…', 'Was mach ich heute?', 'Mal sehen…'], sqichy: ['Blubb… hmm.'] },
  stroll: { person: ['Komm, wir gehen spazieren!'], sqichy: ['Blubb, spazieren!'] },
  strollYes: { person: ['Gerne!', 'Au ja, los!'], sqichy: ['Gerne, Blubb!'] },
  newest: { person: ['Oooh, was ist das Neue?', 'Schau mal da!'], sqichy: ['Blubb, neu!'] },
  count: { person: ['1, 2, 3 … ich komme!', 'Eins, zwei, drei… ich komme!'], sqichy: ['Blubb… eins, zwei, drei!'] },
  curious: { sqichy: ['Oh, was ist das?', 'Blubb? Neu hier!'], person: ['Oh, was ist das?', 'Schau mal, etwas Neues!', 'Hallo, du Neuer!'] },
};

// a few remembered moments per character; chats between the same two sometimes bring them up
const remember = (a, who, kind) => { a.memo = [...(a.memo || []), { who: who.id, kind }].slice(-4); };
// door visits: walk to a door, step inside (hidden) for a while, then come back out
// doors (go in to rest) and items (fetch a key for a lock): called for each candidate goal
export function options(a, add, { spots, cover, spotCell }) {
  for (const sp of spots()) {
    if (sp.kind === 'door' && spotCell(sp, a)) add(0.2 + (1 - a.energy) * 0.8 + (cover() > 0.5 ? 0.6 : 0), { type: 'visit', spot: sp, cell: spotCell(sp, a), phase: 'walk' });
    if (sp.kind === 'item' && sp.carrier === a) {       // carrying a key: keep bringing it to the lock
      const lock = spots().find(l => l.kind === 'lock' && l.needs === sp.item && !l.opened);
      if (lock) add(5, { type: 'bring', item: sp, lock });
    }
    if (sp.kind === 'item' && !sp.carrier && a.traits.curiosity > 0.3 && spots().some(l => l.kind === 'lock' && l.needs === sp.item && !l.opened))
      add(0.4 + a.traits.curiosity * 0.5, { type: 'fetch', spot: sp });
  }
}

// items and locks: a curious character picks up a free item and carries it to the matching lock
function carry(a, g, { now, step, say, line, nearest, spots, spotCell, actors }) {
  if (g.type === 'fetch') {
    const item = g.spot;
    const c = item.carrier ? null : nearest(item.x, item.z, a);
    if (!c) { a.goal = null; return; }
    if (Math.hypot(a.cell.x - c.x, a.cell.y - c.y) > 1.5) { if (!step(a, c.x, c.y)) a.goal = null; return; }
    const lock = spots().find(l => l.kind === 'lock' && l.needs === item.item && !l.opened);
    if (!lock || item.carrier) { a.goal = null; return; }
    item.carrier = a; say(a, line(a, 'found'), 2);
    a.goal = { type: 'bring', item, lock }; a.goalSince = now();
    return;
  }
  // bring: walk to the lock and open it
  const { item, lock } = g;
  const drop = () => { if (item.carrier === a) item.carrier = null; a.goal = null; };
  if (item.carrier !== a || lock.opened) return drop();
  item.x = a.pos.x; item.z = a.pos.z;
  const c = g.cell ??= spotCell(lock, a);     // pick the spot once: spotCell has random jitter
  if (!c) return drop();
  if (Math.hypot(a.cell.x - c[0], a.cell.y - c[1]) > 1.5) { if (!step(a, c[0], c[1])) drop(); return; }
  lock.opened = true; lock.openedAt = now();
  say(a, line(a, 'open'), 2.4); sound.at(a.rig.g).tune();
  let i = 0;
  for (const b of actors()) {                              // friends nearby come to cheer
    if (b === a || b.hidden || b.goal?.type?.match(/chase|flee|visit/) || Math.max(Math.abs(b.cell.x - c[0]), Math.abs(b.cell.y - c[1])) > 5) continue;
    const t = 2 * Math.PI * ++i / 4;
    b.goal = { type: 'circle', cell: [c[0] + Math.round(2 * Math.cos(t)), c[1] + Math.round(2 * Math.sin(t))], until: now() + 20 };
    b.goalSince = now(); say(b, line(b, 'treasure'), 2, 0.6 + i * 0.3);
  }
  a.goal = { type: 'circle', cell: [c[0], c[1]], until: now() + 20 }; a.goalSince = now();
}

export function visit(a, g, api) {
  const { now, step, say, line, R, nearest, busy, bond } = api;
  if (g.type !== 'visit') return carry(a, g, api);
  if (g.phase === 'walk') {
    if (Math.hypot(a.cell.x - g.cell[0], a.cell.y - g.cell[1]) > 1.5) { if (!step(a, g.cell[0], g.cell[1])) a.goal = null; return; }
    if (g.knock) {                                   // a friend knocks: whoever is inside may come out
      say(a, line(a, 'knock'), 1.8);
      if (g.knock.hidden && g.knock.goal?.phase === 'inside') { g.knock.goal.until = now(); g.knock.goal.guest = a; }
      a.goal = null;
      return;
    }
    g.phase = 'entering'; g.until = now() + 1.4;
    say(a, line(a, 'enter'), 1.4);
  } else if (g.phase === 'entering' && now() > g.until) {
    g.phase = 'inside'; g.until = now() + 8 + R() * 12;
    a.hidden = true; a.rig.g.visible = false;
    g.spot.occupants = (g.spot.occupants || 0) + 1;      // the house can light its window
  } else if (g.phase === 'inside') {
    a.energy = Math.min(1, a.energy + 0.02);
    if (now() < g.until && a.energy < 1) return;
    a.hidden = false; a.rig.g.visible = true;
    const free = nearest(a.pos.x, a.pos.z, a);      // others may have stepped onto the door cell meanwhile
    if (free) a.cell = free;
    g.spot.occupants = Math.max(0, (g.spot.occupants || 1) - 1);
    say(a, line(a, 'back'), 2);
    if (g.guest) {                                   // ...and then they chat at the door
      busy(a, g.guest, 'talk', 3); busy(g.guest, a, 'talk', 3);
      say(g.guest, line(g.guest, 'chat'), 2, 0.8); bond(a, g.guest, 0.15);
    }
    a.goal = null;
  }
}

// running from a chaser: slip behind an obstacle, i.e. go to the nearest cell the chaser cannot see
export function hide(a, from, { seen, pass, step, now, actors }) {
  const f = a.flee;
  if (!from.cell) return false;
  if (!f.hideAt || now() > f.hideT) {                  // re-plan now and then, the chaser moves too
    const hidden = seen(from.cell.x, from.cell.y);
    // hide behind a bigger friend if there is one close by, otherwise just out of sight
    const shield = actors().filter(o => o !== a && o !== from && o.radius > a.radius * 1.5 && !o.hidden)
      .sort((p, q) => Math.hypot(p.cell.x - a.cell.x, p.cell.y - a.cell.y) - Math.hypot(q.cell.x - a.cell.x, q.cell.y - a.cell.y))[0];
    const ref = shield && Math.hypot(shield.cell.x - a.cell.x, shield.cell.y - a.cell.y) < 8 ? shield.cell : a.cell;
    let best = null, bd = 1e9;
    for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) {
      const x = a.cell.x + dx, y = a.cell.y + dy, d = Math.hypot(x - ref.x, y - ref.y);
      if (d >= bd || hidden.has(x + ',' + y) || !pass(a)(x, y) || actors().some(o => o !== a && o.cell.x === x && o.cell.y === y)) continue;
      bd = d; best = [x, y];
    }
    f.hideAt = best || false; f.hideT = now() + 0.5;
  }
  const h = f.hideAt;
  if (!h) return false;
  if (a.cell.x === h[0] && a.cell.y === h[1] && !seen(from.cell.x, from.cell.y).has(a.cell.x + "," + a.cell.y)) return true;   // out of sight: stay put
  if (!step(a, h[0], h[1])) { f.hideAt = false; return false; }
  return true;
}

// something new was drawn: curious characters close by walk over to look at it
let newest = null, freezeAt = null;                                 // where the newest thing appeared
export function inspect(wx, wz, who, { nearest, actors, now, R, say, line }) {
  newest = { x: wx, z: wz };
  const c = nearest(wx, wz);
  if (!c) return;
  for (const a of actors()) {
    const d = Math.max(Math.abs(a.cell.x - c.x), Math.abs(a.cell.y - c.y));
    if (a === who || now() < a.busyUntil || a.flee || a.traits.curiosity < 0.4 || d > 10 || R() > 0.7) continue;
    a.goal = { type: 'wander', cell: [c.x, c.y] }; a.goalSince = now();
    say(a, line(a, 'curious'), 2.2, d * 0.4 + 0.5);
  }
}

export const INTERACTIONS = {
  greet(a, b, { busy, say, line, bond }) {
    busy(a, b, 'wave', 2.6); busy(b, a, 'wave', 2.6);
    say(a, line(a, 'greet')); say(b, line(b, 'greet'), 2.2, 1.1);
    bond(a, b, 0.25);
  },
  chat(a, b, { busy, say, line, bond, actors, pick, R }) {
    busy(a, b, 'talk', 3.2); busy(b, a, 'talk', 3.2);
    const memo = (a.memo || []).filter(m => m.who === b.id).pop();
    say(a, memo && R() < 0.5 ? line(a, 'recall_' + memo.kind) : line(a, 'chat'), 2.2); say(b, line(b, 'reply'), 2, 1.6);
    bond(a, b, 0.12); a.social -= 0.3; b.social -= 0.3;
    // gossip: a tells b what a thinks of a third character, and b's opinion drifts toward it
    const others = actors().filter(x => x !== a && x !== b && Math.abs(a.rel[x.id] ?? 0) > 0.4);
    if (others.length && R() < 0.5) {
      const x = pick(others), good = a.rel[x.id] > 0;
      say(a, line(a, good ? 'gossipGood' : 'gossipBad'), 2, 2.6);
      b.rel[x.id] = Math.max(-1, Math.min(1, (b.rel[x.id] ?? 0) + 0.2 * a.rel[x.id]));
    }
  },
  spar(a, b, { busy, say, line, bond, R }) {
    const sq = a.kind === 'squid' ? a : b, o = sq === a ? b : a;
    busy(sq, o, 'swing', 2.2); busy(o, sq, 'scared', 2.2);
    say(sq, line(sq, 'spar'), 1.8); say(o, line(o, 'spar'), 1.6, 0.6);
    o.fear += 0.6 * (1 - o.traits.bravery);
    bond(a, b, 0.2);          // a friendly practice duel; they get along better afterwards
    if (R() < 0.6) {          // ...and afterwards the squid apologises and the other forgives
      say(sq, line(sq, 'sorry'), 2, 4.2); say(o, line(o, 'forgive'), 2, 5.8);
      o.fear *= 0.5;
    }
  },
  dance(a, b, { busy, say, line, bond }) {
    busy(a, b, 'dance', 3.4); busy(b, a, 'dance', 3.4);
    say(a, line(a, 'dance')); say(b, line(b, 'dance'), 2, 0.8);
    bond(a, b, 0.05); a.energy -= 0.2; b.energy -= 0.2; a.social = b.social = 0;
    say(a, '♥', 1.2, 2.0);       // a little heart after a good dance
    sound.at(a.rig.g).tune();
  },
  highfive(a, b, { busy, say, line, bond }) {
    busy(a, b, 'highfive', 1.4); busy(b, a, 'highfive', 1.4);
    say(a, line(a, 'highfive'), 1.4);
    bond(a, b, 0.05); a.social -= 0.4; b.social -= 0.4;
    sound.at(a.rig.g).plop();
  },
  tagStart(a, b, { busy, say, line, now }) {
    busy(a, b, 'highfive', 0.8);
    say(a, line(a, 'tagStart'), 1.8);
    b.busyUntil = now() + 0.9; b.goal = { type: 'chase', target: a, until: now() + 8, rounds: 3 };
    a.goal = null; a.busyUntil = now() + 0.6;
    a.flee = { from: b, until: now() + 8 };
  },
  spook(a, b, { busy, say, line, bond, now, actors }) {   // the feared one says boo; the scared one slowly gets used to it
    const victim = a.fears?.includes(b.id) ? a : b, boo = victim === a ? b : a;
    busy(boo, victim, 'wave', 2.2); busy(victim, boo, 'scared', 2.2);
    say(boo, line(boo, 'spook'), 1.8); say(victim, line(victim, 'scared'), 1.8, 0.5);
    bond(boo, victim, 0.18);
    sound.at(boo.rig.g).buh();
    victim.calmUntil = now() + 6;
    remember(victim, boo, 'spook');
    victim.scares = victim.scares || {};
    victim.scares[boo.id] = (victim.scares[boo.id] || 0) + 1;
    if (victim.scares[boo.id] >= 3 && victim.fears?.includes(boo.id)) {       // the third time: stand up to it
      victim.fears = victim.fears.filter(id => id !== boo.id); victim.scares[boo.id] = 0;
      say(victim, line(victim, 'brave'), 2.2, 1.0); bond(boo, victim, 0.5);
    }
    const bystander = actors().find(c => c !== boo && c !== victim && !c.hidden && Math.max(Math.abs(c.cell.x - victim.cell.x), Math.abs(c.cell.y - victim.cell.y)) <= 4);
    if (bystander) { bystander.fear = Math.max(bystander.fear, 0.35); say(bystander, line(bystander, 'startled'), 1.6, 1.0); }   // the scare spreads
  },
  share(a, b, { busy, say, line, bond }) {       // a well-fed friend gives some food to a hungry one
    const [giver, taker] = a.hunger < 0.2 ? [a, b] : [b, a];
    busy(giver, taker, 'highfive', 1.6); busy(taker, giver, 'wave', 1.6);
    say(giver, line(giver, 'share'), 2); say(taker, line(taker, 'thanksFood'), 1.8, 1.4);
    taker.hunger = 0.1; bond(a, b, 0.2);
    say(giver, '♥', 1.2, 3.4);
  },
  comfort(a, b, { busy, say, line, bond, now }) {   // whoever is still shaken gets calmed by the other
    const [comforter, victim] = b.fear > 0.3 ? [a, b] : [b, a];
    busy(comforter, victim, 'talk', 2.8); busy(victim, comforter, 'idle', 2.8);
    const paid = (comforter.memo || []).some(m => m.who === victim.id && m.kind === 'comfort');   // comforted before: pays it forward
    say(comforter, line(comforter, paid ? 'paidBack' : 'comfort'), 2); say(victim, line(victim, 'thanks'), 1.8, 1.2);
    victim.fear *= 0.4; victim.calmUntil = now() + 6;
    bond(comforter, victim, 0.15);
    remember(victim, comforter, 'comfort');
    say(comforter, '♥', 1.2, 3.2);
  },
};
Object.assign(INTERACTIONS, { chaseSmall, showEgg });

// every few seconds: three or more calm people close together form a ring and dance
let lastCover = 0;
let game = null;                                   // hide and seek: { seeker, at }
const dist = (p, q) => Math.max(Math.abs(p.cell.x - q.cell.x), Math.abs(p.cell.y - q.cell.y));

export function tick(actors, { now, R, pick, line, say, rel, spots, nearest }, cover) {
  // items: a carried item follows its carrier; a carrier who left or hid drops it; opened locks close again
  for (const it of spots().filter(s => s.kind === 'item')) {
    it.home ??= { x: it.x, z: it.z };
    if (it.carrier && (!actors.includes(it.carrier) || it.carrier.hidden)) it.carrier = null;
    else if (it.carrier) { it.x = it.carrier.pos.x; it.z = it.carrier.pos.z; }
  }
  for (const lk of spots().filter(s => s.kind === 'lock' && s.opened && now() > s.openedAt + 30)) {
    lk.opened = false;
    for (const it of spots().filter(s => s.kind === 'item' && s.item === lk.needs)) {
      if (it.carrier?.goal?.type === 'circle') it.carrier.goal = null;
      it.carrier = null; it.x = it.home.x; it.z = it.home.z;
    }
  }
  const calm = a => a.kind !== 'squid' && !a.goal?.type?.match(/chase|flee|visit/) && a.fear < 0.2 && a.energy > 0.4 && now() >= a.busyUntil;
  const cell = a => a.goal?.cell ? { x: a.goal.cell[0], y: a.goal.cell[1] } : a.cell;
  // weather: when the sun comes back everyone notices
  if (lastCover > 0.6 && cover < 0.3) for (const a of actors) if (calm(a) && R() < 0.5) say(a, line(a, 'clear'), 2, R() * 2);
  lastCover = cover;
  // everyone looks up at the newest thing now and then
  if (newest && freezeAt === null) freezeAt = now() + 150 + R() * 90;
  if (newest && now() >= freezeAt) {
    freezeAt = now() + 180 + R() * 120;
    for (const a of actors) if (calm(a)) {
      a.goal = { type: 'idle', until: now() + 3 }; a.goalSince = now();
      a.face = Math.atan2(newest.x - a.pos.x, newest.z - a.pos.z);
      say(a, line(a, 'newest'), 1.8, R() * 0.8);
    }
  }
  for (const a of actors) {
    // a followed character (the camera is on it) waves at the viewer now and then
    if (a.followed && R() < 0.1) { a.anim = 'wave'; a.animStart = now(); a.animUntil = now() + 1.8; say(a, 'Hallo du da draußen!', 1.8); }
    if (a.goal?.type !== 'idle' || !calm(a) || R() > 0.25) continue;
    // alone and idle: a little thought
    if (!actors.some(b => b !== a && dist(a, b) <= 6)) say(a, line(a, 'think'), 1.8);
    continue;
  }
  // curious: walk to a random thing and comment on it by name
  const things = spots().filter(s => s.kind !== 'item' && s.kind !== 'lock');
  for (const a of actors) if (calm(a) && things.length && R() < 0.03) {
    const sp = pick(things), c = nearest(sp.x, sp.z, a);
    if (!c) continue;
    a.goal = { type: 'wander', cell: [c.x, c.y] }; a.goalSince = now();
    say(a, sp.name ? `Oh, ${sp.name}!` : line(a, 'look'), 2.2, dist(a, { cell: c }) * 0.4 + 0.5);
  }
  // good friends sometimes stroll side by side
  for (const a of actors) {
    if (!calm(a) || R() > 0.1) continue;
    const b = actors.find(o => o !== a && calm(o) && rel(a, o) > 0.5 && dist(a, o) <= 4);
    if (!b) continue;
    const c = nearest(a.pos.x + (R() - 0.5) * 8, a.pos.z + (R() - 0.5) * 8, a);
    if (!c) continue;
    for (const m of [a, b]) { m.goal = { type: 'wander', cell: [c.x, c.y] }; m.goalSince = now(); }
    say(a, line(a, 'stroll'), 2, 0.2); say(b, line(b, 'strollYes'), 1.8, 1.2);
    break;
  }
  // hide and seek: one counts, the others hide from them, then the seeker goes looking
  if (game && !actors.includes(game.seeker)) game = null;   // the seeker left the world
  if (game && now() >= game.at) {
    const hiders = actors.filter(h => h !== game.seeker && h.flee?.from === game.seeker && !h.hidden);
    const prey = hiders.sort((p, q) => dist(game.seeker, p) - dist(game.seeker, q))[0];
    if (prey) game.seeker.goal = { type: 'chase', target: prey, until: now() + 25, rounds: 1 };
    game = null;
  }
  if (!game && R() < 0.15) {
    const pool = actors.filter(a => calm(a) && a.kind !== 'squid');
    const seeker = pool.length ? pick(pool) : null;
    const hiders = seeker ? pool.filter(h => h !== seeker && dist(h, seeker) <= 5) : [];
    if (hiders.length >= 1) {
      say(seeker, line(seeker, 'count'), 2.6);
      seeker.busyUntil = now() + 3;
      for (const h of hiders) h.flee = { from: seeker, until: now() + 15 };
      game = { seeker, at: now() + 3 };
    }
  }
  // someone is inside a house: a friend close by may knock
  const inside = actors.find(h => h.hidden && h.goal?.phase === 'inside' && !h.goal.guest);
  if (inside && R() < 0.5) {
    const f = actors.find(f => f !== inside && calm(f) && rel(f, inside) > 0.3 &&
      Math.max(Math.abs(f.cell.x - cell(inside).x), Math.abs(f.cell.y - cell(inside).y)) < 14);
    if (f) { f.goal = { type: 'visit', spot: inside.goal.spot, cell: [inside.goal.cell[0], inside.goal.cell[1]], phase: 'walk', knock: inside }; f.goalSince = now(); }
  }
  for (const a of actors) {
    if (!calm(a) || a.goal?.type === 'circle' || now() - (a.circleAt ?? -99) < 20 || R() > 0.4) continue;   // a circle dance, then walk on for a while
    const near = actors.filter(b => b !== a && calm(b) && b.goal?.type !== 'circle' && now() - (b.circleAt ?? -99) >= 20 && Math.max(Math.abs(a.cell.x - b.cell.x), Math.abs(a.cell.y - b.cell.y)) <= Math.max(3, Math.ceil((a.radius + b.radius) * 2 / 0.45)));   // big bodies gather from further away
    if (near.length < 2) continue;
    const ring = [a, ...near.slice(0, 3)], cx = a.cell.x, cy = a.cell.y;
    const rr = Math.max(2, Math.ceil(2.2 * Math.max(...ring.map(m => m.radius)) / 0.45));   // big bodies need a wider ring
    ring.forEach((m, i) => {
      const t = 2 * Math.PI * i / ring.length;
      m.goal = { type: 'circle', cell: [cx + Math.round(rr * Math.cos(t)), cy + Math.round(rr * Math.sin(t))], until: now() + 9 };
      m.goalSince = now(); m.circleAt = now();
    });
    say(a, line(a, 'group'), 2.2, 0.3);
    for (const m of ring) for (const o of ring) if (m !== o) m.rel[o.id] = Math.min(1, (m.rel[o.id] ?? 0) + (m.fears?.includes(o.id) ? 0.25 : 0.05));
    const scared = ring.find(m => m.fears?.some(id => ring.some(o => o.id === id)));
    if (scared) say(scared, line(scared, 'makeup'), 2, 2.4);       // "Gruselparty": the fearful ones make up
    return;                                  // one group at a time
  }
}

// a small creature and a bigger friend: the friend playfully chases it (uses the tag game)
export function chaseSmall(a, b, { busy, say, line, now, bond }) {
  const [small, big] = a.radius < b.radius ? [a, b] : [b, a];
  busy(small, big, 'highfive', 0.8);
  say(small, line(small, 'tagStart'), 1.8);
  big.busyUntil = now() + 0.9; big.goal = { type: 'chase', target: small, until: now() + 8, rounds: 3 };
  small.goal = null; small.busyUntil = now() + 0.6;
  small.flee = { from: big, until: now() + 8 };
  bond(big, small, 0.05);
}

// "Schau mal, mein Ei!": whoever found an egg shows it to a friend, who loves it
export function showEgg(a, b, { busy, say, line, bond }) {
  const [giver, friend] = a.eggs ? [a, b] : [b, a];
  giver.eggs--;
  busy(giver, friend, 'highfive', 1.6); busy(friend, giver, 'talk', 1.6);
  say(giver, line(giver, 'showEgg'), 2);
  say(friend, '♥', 1.2, 1.4);
  bond(giver, friend, 0.25);
}

export function choose(a, b, r, { R, pick, rel }) {
  const feared = a.fears?.includes(b.id) ? a : b.fears?.includes(a.id) ? b : null;
  if (feared && rel(feared, feared === a ? b : a) < 0.45) return 'spook';
  const squidInvolved = a.kind === 'squid' || b.kind === 'squid';
  const shaken = a.fear > 0.3 ? a : b.fear > 0.3 ? b : null;
  // a shaken character meets a friend who is not shaken: the friend comforts them
  if (shaken && r > 0.3 && (shaken === a ? b : a).fear < 0.1) return 'comfort';
  const hungry = a.hunger > 0.6 ? a : b.hunger > 0.6 ? b : null;
  if (hungry && (hungry === a ? b : a).hunger < 0.2 && rel(a, b) > 0.3) return 'share';
  if ((a.eggs || b.eggs) && rel(a, b) > 0.2) return 'showEgg';
  if (!squidInvolved && rel(a, b) > 0.3 && Math.abs(a.radius - b.radius) > 0.1 && R() < 0.4) return 'chaseSmall';
  if (squidInvolved && R() < 0.3) return 'spar';
  if (r < 0.3) return 'greet';
  if (r > 0.6) return pick(['dance', 'highfive', 'chat', ...(!squidInvolved && a.energy > 0.5 ? ['tagStart'] : [])]);
  return 'chat';
}
