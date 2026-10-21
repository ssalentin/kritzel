// Deterministic movement for the pixel book; no simulation state is shared with the 3D viewer.
export const MOVERS = ['walk', 'roll', 'fly', 'swim', 'hop', 'climb'];
export const PAGE = { x0: 28, x1: 292, y0: 64, y1: 172 };

const DEFAULT_SPEED = { walk: 22, roll: 34, fly: 28, swim: 17, hop: 19, climb: 15 };

export function moverFor(thing) {
  const explicit = String(thing.move || thing.mover || '').toLowerCase();
  if (MOVERS.includes(explicit)) return explicit;
  const text = `${thing.name || ''} ${thing.drawing || ''}`.toLowerCase();
  if (/rollstuhl|wheelchair|fahrrad|bike|auto|car|bus|zug|train/.test(text)) return 'roll';
  if (/drache|dragon|vogel|bird|eule|owl|hexe|witch|fliege|biene|bee|flug|flugzeug|plane/.test(text)) return 'fly';
  if (/fisch|fish|wal|whale|hai|shark|ente|duck|pinguin|penguin|meerjungfrau|mermaid/.test(text)) return 'swim';
  if (/spinne|spider|eichh|squirrel|affe|monkey|kletter|climb|im baum|in a tree|in the tree|auf dem baum/.test(text)) return 'climb';
  if (/hase|rabbit|frosch|frog|hüpf|hop/.test(text)) return 'hop';
  return 'walk';
}

function randomFor(text) {
  let state = 2166136261;
  for (const c of text) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function overlaps(x, y, w, h, obstacle) {
  return x + w > obstacle.x - obstacle.w / 2 && x - w < obstacle.x + obstacle.w / 2
    && y + h > obstacle.y - obstacle.h && y - h < obstacle.y;
}

function pickTarget(actor, obstacles, bounds) {
  if (actor.mover === 'climb') {
    const tree = obstacles.find(o => o.kind === 'tree') || obstacles[0];
    if (tree) {
      return { x: tree.x + (actor.random() < .5 ? -1 : 1) * (tree.w / 2 + 5), y: tree.y - tree.h * (.35 + actor.random() * .4) };
    }
  }
  const y0 = actor.mover === 'fly' ? 48 : actor.mover === 'swim' ? 126 : bounds.y0;
  const y1 = actor.mover === 'fly' ? 118 : bounds.y1;
  for (let attempt = 0; attempt < 24; attempt++) {
    const x = bounds.x0 + actor.random() * (bounds.x1 - bounds.x0);
    const y = y0 + actor.random() * (y1 - y0);
    if (actor.mover === 'fly' || !obstacles.some(o => overlaps(x, y, 14, 14, o))) return { x, y };
  }
  return { x: (bounds.x0 + bounds.x1) / 2, y: 132 };
}

export function createActor(thing, seed = 0) {
  const mover = moverFor(thing);
  const random = randomFor(`${seed}:${thing.id || thing.file || thing.name}`);
  const sleeping = thing.state === 'sleep' || /schlaf|sleep/.test(`${thing.name || ''} ${thing.drawing || ''}`.toLowerCase());
  return {
    id: thing.id || thing.file || thing.name,
    thing: thing.thing || thing,
    mover,
    speed: Number.isFinite(thing.speed) ? Math.max(6, Math.min(60, thing.speed)) : DEFAULT_SPEED[mover],
    x: +thing.x || 0,
    y: +thing.y || 0,
    target: null,
    state: sleeping ? 'sleep' : 'idle',
    pause: sleeping ? Infinity : .4 + random() * 1.2,
    react: 0,
    facing: random() < .5 ? -1 : 1,
    phase: random() * Math.PI * 2,
    random,
  };
}

export function stepActor(actor, dt, obstacles = [], bounds = PAGE) {
  dt = Math.max(0, Math.min(.1, dt));
  if (actor.react > 0) actor.react = Math.max(0, actor.react - dt);
  if (actor.pause > 0) {
    actor.pause -= dt;
    actor.state = actor.pause === Infinity ? 'sleep' : 'idle';
    return false;
  }
  if (!actor.target) actor.target = pickTarget(actor, obstacles, bounds);
  const dx = actor.target.x - actor.x, dy = actor.target.y - actor.y, d = Math.hypot(dx, dy);
  if (d < 2) {
    actor.target = null;
    actor.pause = .7 + actor.random() * 2.2;
    actor.state = 'idle';
    return true;
  }
  const step = Math.min(d, actor.speed * dt), nx = actor.x + dx / d * step, ny = actor.y + dy / d * step;
  if (actor.mover !== 'fly' && actor.mover !== 'climb' && obstacles.some(o => overlaps(nx, ny, 14, 14, o))) {
    actor.target = null;
    actor.pause = .15;
    actor.state = 'idle';
    return true;
  }
  actor.x = Math.max(bounds.x0, Math.min(bounds.x1, nx));
  actor.y = Math.max(actor.mover === 'fly' ? 46 : bounds.y0, Math.min(actor.mover === 'swim' ? 170 : bounds.y1, ny));
  actor.facing = dx < 0 ? -1 : 1;
  actor.phase += dt * (actor.mover === 'roll' ? 11 : 7);
  actor.state = 'move';
  return true;
}

export function react(actor, ms = 1100) {
  actor.react = ms / 1000;
  actor.pause = .65;
  actor.state = 'greet';
}
