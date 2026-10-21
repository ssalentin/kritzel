// Top-down Matter.js world for pixel objects. Matter is injected so the node tests can use the
// pinned npm copy while the browser imports the same version from the CDN.
export const PHYSICS_STEP_MS = 1000 / 60;
export const MAX_THROW_SPEED = 18;   // scene pixels per 1/60 s
export const HOLD_LIFT = 6;

export function createPhysics(Matter, { bounds, statics = [], portables = [], actors = [] }) {
  const { Engine, Bodies, Body, Composite, Bounds, Sleeping } = Matter;
  const engine = Engine.create({ gravity: { x: 0, y: 0 }, enableSleeping: false });
  engine.positionIterations = 10;
  engine.velocityIterations = 8;
  const world = engine.world;
  const portableBodies = new Map(), actorBodies = new Map(), allPortable = [];
  let accumulator = 0, held = null;

  const wall = (x, y, w, h, label) => Composite.add(world,
    Bodies.rectangle(x, y, w, h, { isStatic: true, friction: .4, restitution: .15, label }));
  const wallSize = 8;
  wall((bounds.x0 + bounds.x1) / 2, bounds.y0 - wallSize / 2, bounds.x1 - bounds.x0 + wallSize * 2, wallSize, 'page-top');
  wall((bounds.x0 + bounds.x1) / 2, bounds.y1 + wallSize / 2, bounds.x1 - bounds.x0 + wallSize * 2, wallSize, 'page-bottom');
  wall(bounds.x0 - wallSize / 2, (bounds.y0 + bounds.y1) / 2, wallSize, bounds.y1 - bounds.y0, 'page-left');
  wall(bounds.x1 + wallSize / 2, (bounds.y0 + bounds.y1) / 2, wallSize, bounds.y1 - bounds.y0, 'page-right');

  const bodyOptions = { frictionAir: .04, friction: .35, restitution: .15, label: 'thing' };
  for (const item of statics) {
    const b = Bodies.rectangle(item.cx, item.cy - item.h / 2, item.w, item.h, { ...bodyOptions, isStatic: true });
    b.plugin.item = item;
    Composite.add(world, b);
  }
  for (const item of portables) {
    const b = Bodies.rectangle(item.cx, item.cy - item.h / 2, item.w, item.h, bodyOptions);
    Body.setMass(b, Math.max(1, item.w * item.h / 400));
    b.plugin.item = item;
    item.physics = 'dynamic';
    portableBodies.set(item, b);
    allPortable.push(b);
    Composite.add(world, b);
  }
  for (const actor of actors) {
    const b = Bodies.circle(actor.x, actor.y - HOLD_LIFT, Math.max(4, actor.radius || 7),
      { isStatic: true, friction: .2, restitution: .05, label: 'actor' });
    b.plugin.actor = actor;
    actor.physics = 'kinematic';
    actorBodies.set(actor, b);
    Composite.add(world, b);
  }

  function syncActors() {
    for (const [actor, body] of actorBodies) Body.setPosition(body, { x: actor.x, y: actor.y - HOLD_LIFT });
  }
  function syncItems() {
    for (const [item, body] of portableBodies) {
      item.cx = body.position.x;
      item.cy = body.position.y + item.h / 2;
      item.angle = body.angle;
    }
  }
  function step(dt) {
    accumulator += Math.min(.1, Math.max(0, dt));
    let count = 0;
    const before = [...portableBodies.values()].map(b => [b, b.position.x, b.position.y, b.angle]);
    while (accumulator >= PHYSICS_STEP_MS / 1000) {
      syncActors();
      Engine.update(engine, PHYSICS_STEP_MS);
      accumulator -= PHYSICS_STEP_MS / 1000;
      count++;
    }
    syncItems();
    const moved = before.some(([b, x, y, angle]) =>
      Math.abs(b.position.x - x) + Math.abs(b.position.y - y) > .01 || Math.abs(b.angle - angle) > .002);
    return { steps: count, moved };
  }
  function portableAt(point) {
    return allPortable.find(body => Bounds.contains(body.bounds, point)) || null;
  }
  function place(item, x, y) {
    const body = portableBodies.get(item);
    if (!body) return false;
    Body.setPosition(body, { x, y: y - item.h / 2 });
    Body.setVelocity(body, { x: 0, y: 0 });
    Body.setAngularVelocity(body, 0);
    syncItems();
    return true;
  }
  function grab(body, point) {
    const item = body.plugin.item;
    Sleeping.set(body, false);
    Body.setStatic(body, true);
    Body.setVelocity(body, { x: 0, y: 0 });
    Body.setAngularVelocity(body, 0);
    held = { body, item, dx: body.position.x - point.x, dy: body.position.y - (point.y - HOLD_LIFT), history: [] };
    return item;
  }
  function moveHeld(point, at = performance.now()) {
    if (!held) return false;
    const target = { x: point.x + held.dx, y: point.y - HOLD_LIFT + held.dy };
    Body.setPosition(held.body, target);
    held.history.push({ ...target, at });
    while (held.history.length > 2 && at - held.history[0].at > 100) held.history.shift();
    syncItems();
    return true;
  }
  function releaseHeld(at = performance.now()) {
    if (!held) return null;
    const { body, history } = held;
    const newest = history.at(-1), oldest = history.find(p => at - p.at <= 100) || history[0];
    let vx = 0, vy = 0;
    if (newest && oldest && newest.at > oldest.at) {
      const factor = PHYSICS_STEP_MS / (newest.at - oldest.at);
      vx = (newest.x - oldest.x) * factor;
      vy = (newest.y - oldest.y) * factor;
      const speed = Math.hypot(vx, vy);
      if (speed > MAX_THROW_SPEED) { vx *= MAX_THROW_SPEED / speed; vy *= MAX_THROW_SPEED / speed; }
    }
    Body.setStatic(body, false);
    Sleeping.set(body, false);
    Body.setVelocity(body, { x: vx, y: vy });
    Body.setAngularVelocity(body, Math.max(-.18, Math.min(.18, vx * .015)));
    const item = held.item;
    held = null;
    return { item, vx, vy };
  }

  return {
    engine, world, portableBodies, actorBodies, step, syncActors, syncItems,
    portableAt, place, grab, moveHeld, releaseHeld,
    get held() { return held?.item || null; },
  };
}
