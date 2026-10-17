// How drawn animals move, picked by the actor: move: 'walk' | 'hop' | 'crawl' | 'fly' | 'swim' | 'climb'.
// walk/hop/crawl go over the sim's grid like everyone (hop bounces, crawl is slow); fly, swim and
// climb leave the grid and run their own little loop here:
//   fly   — loops in the air, then lands on top of a thing (or the grass) for a while, and off again
//   swim  — stays in drawn water (ponds, rivers); without water it walks
//   climb — wanders, climbs the nearest tall thing, sits on top, climbs down again
// Each actor gets a `lift` group between its parent and its rig, so a height can be added under
// whatever its own animate() does with rig.g.position.y.

export const SPEED = { walk: 1, hop: 1.1, crawl: 0.4 };

export function makeMoves({ THREE, R, ground = null }) {
  // keep to the ground: the book's pages (a rectangle), or the old round island
  const inIsland = p => {
    if (ground) {
      p.x = Math.max(-ground.w / 2 + 0.5, Math.min(ground.w / 2 - 0.5, p.x));
      p.z = Math.max(-ground.d / 2 + 0.5, Math.min(ground.d / 2 - 0.5, p.z));
      return p;
    }
    const d = Math.hypot(p.x, p.z);
    if (d > 6.3) { p.x *= 6.3 / d; p.z *= 6.3 / d; }
    return p;
  };
  const pick = list => list[Math.floor(R() * list.length)];

  // the body of water nearest to (x, z): a fish keeps to one, it doesn't cross land
  const zoneDist = (q, x, z) => q.kind === 'pond' ? Math.max(0, Math.hypot(x - q.x, z - q.z) - q.r)
    : Math.min(...q.points.map(p => Math.hypot(x - p.x, z - p.z)));
  const nearestZone = (zones, x, z) => zones.reduce((b, q) => zoneDist(q, x, z) < zoneDist(b, x, z) ? q : b);
  // a point in that water: random in a pond, or along a river
  function waterPoint(z) {
    if (z.kind === 'pond') { const a = R() * Math.PI * 2, r = Math.sqrt(R()) * z.r * 0.7; return { x: z.x + Math.cos(a) * r, z: z.z + Math.sin(a) * r }; }
    const p = pick(z.points);
    return { x: p.x + (R() - 0.5) * z.width * 0.5, z: p.z + (R() - 0.5) * z.width * 0.5 };
  }

  // a climber keeps off things and other figures on the ground: a thing's footprint (grown by the
  // climber's radius), or another figure standing on the ground close by. `skip` is the perch it is
  // climbing onto, whose footprint it must reach. pen() is how far (x, z) is inside the nearest one
  // (more than 0 is inside; -Infinity when nothing is near).
  const pen = (a, x, z, env, skip) => {
    let p = -Infinity;
    for (const f of env.feet || []) if (f !== skip?.foot) p = Math.max(p, Math.min(f.hx + a.radius - Math.abs(x - f.x), f.hz + a.radius - Math.abs(z - f.z)));
    for (const o of env.actors || []) if (o !== a && !o.hidden && (o.alt || 0) < 0.3) p = Math.max(p, a.radius + (o.radius || 0.1) - Math.hypot(x - o.pos.x, z - o.pos.z));
    return p;
  };

  // walk/fly/swim straight toward (x, z): returns true when there
  function toward(a, x, z, speed, dt) {
    const dx = x - a.pos.x, dz = z - a.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.08) return true;
    const s = Math.min(d, speed * dt);
    a.pos.x += dx / d * s; a.pos.z += dz / d * s; a.face = Math.atan2(dx, dz);
    return false;
  }

  // one climber's step toward (x, z) on the ground: true when there, false when moving, null when blocked
  function walkTo(a, x, z, speed, dt, env, perch = null) {
    const dx = x - a.pos.x, dz = z - a.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.08) return true;
    const s = Math.min(d, speed * dt), nx = a.pos.x + dx / d * s, nz = a.pos.z + dz / d * s;
    // a step may not go into a thing or figure, nor deeper into one; one already in a tight spot may walk out
    const p0 = pen(a, a.pos.x, a.pos.z, env, perch), p1 = pen(a, nx, nz, env, perch);
    if (p1 > 0 && p1 >= p0) return null;
    a.pos.x = nx; a.pos.z = nz; a.face = Math.atan2(dx, dz);
    return false;
  }

  return {
    // fly, climb, and swim where there is water, leave the grid
    // (not while held: a creature in a cage walks the grid, where the hold keeps it in)
    special: (a, env) => !a.hold && (a.move === 'fly' || a.move === 'climb' || (a.move === 'swim' && env.water?.length > 0)),

    setup(a) {
      const g = a.rig?.g;
      if (!g || a.lift || !g.parent) return;
      a.lift = new THREE.Group();
      g.parent.add(a.lift);
      a.lift.add(g);
    },

    // one frame for an off-grid mover: sets a.pos, a.face and a.alt; returns whether it is moving
    update(a, dt, now, env) {
      const m = a.mv ||= { phase: '' }, sp = 1.6 * (a.speed || 1);
      const perches = env.perches || [];
      if (a.move === 'fly') {
        if (!m.phase) Object.assign(m, { phase: 'loop', cx: a.pos.x, cz: a.pos.z, r: 1.5 + R(), ang: 0, until: now + 6 + R() * 4 });
        if (m.phase === 'loop') {
          m.ang += dt * sp * 1.3 / m.r;
          const nx = m.cx + Math.cos(m.ang) * m.r, nz = m.cz + Math.sin(m.ang) * m.r;
          a.face = Math.atan2(nx - a.pos.x, nz - a.pos.z);
          a.pos.x = nx; a.pos.z = nz;
          a.alt += ((2.6 + Math.sin(now * 1.7) * 0.3) - a.alt) * Math.min(1, dt * 2);
          if (now > m.until) {                    // land on top of a thing (not too high), or on the grass
            const ok = perches.filter(p => p.top < 4.5);
            const p = ok.length && R() < 0.75 ? pick(ok) : inIsland({ x: (R() - 0.5) * 15, z: (R() - 0.5) * 11, top: 0 });
            Object.assign(m, { phase: 'land', tx: p.x, tz: p.z, top: p.top });
          }
          return true;
        }
        if (m.phase === 'land') {
          const there = toward(a, m.tx, m.tz, sp * 1.4, dt);
          a.alt += ((there ? m.top : Math.max(m.top + 0.6, 1.2)) - a.alt) * Math.min(1, dt * 2.5);
          if (there && Math.abs(a.alt - m.top) < 0.05) Object.assign(m, { phase: 'sit', until: now + 5 + R() * 6 });
          return true;
        }
        a.alt = m.top;                            // sitting
        if (now > m.until) {                      // off again: a new loop that starts where it sits
          const r = 1.4 + R() * 1.2, ang = R() * Math.PI * 2;
          const c = inIsland({ x: a.pos.x - Math.cos(ang) * r, z: a.pos.z - Math.sin(ang) * r });
          Object.assign(m, { phase: 'loop', r, ang, cx: c.x, cz: c.z, until: now + 6 + R() * 5 });
        }
        return false;
      }

      if (a.move === 'swim') {
        const zone = nearestZone(env.water, a.pos.x, a.pos.z);
        if (!m.phase) { const p = waterPoint(zone); a.pos.x = p.x; a.pos.z = p.z; m.phase = 'swim'; m.until = 0; }   // into the water
        if (!m.tx || now > m.until) { const p = waterPoint(zone); Object.assign(m, { tx: p.x, tz: p.z, until: now + 6 + R() * 4 }); }
        const there = toward(a, m.tx, m.tz, sp * 0.8, dt);
        a.alt = -0.08 + Math.sin(now * 2.4 + a.pos.x) * 0.03;      // in the water, bobbing
        if (there) m.until = Math.min(m.until, now + 1 + R() * 2);
        return !there;
      }

      // climb: walks on the ground round things and figures, and turns to a new goal when one is in the way
      if (!m.phase) Object.assign(m, { phase: 'roam', until: now + 4 + R() * 4 });
      if (m.phase === 'roam') {
        if (m.tx === undefined) { const p = inIsland({ x: a.pos.x + (R() - 0.5) * 3, z: a.pos.z + (R() - 0.5) * 3 }); m.tx = p.x; m.tz = p.z; }
        const there = walkTo(a, m.tx, m.tz, sp * 0.7, dt, env);
        a.alt += (0 - a.alt) * Math.min(1, dt * 4);
        if (there === null) m.tx = m.tz = undefined;     // in the way: another goal
        else if (there) m.tx = m.tz = undefined;
        const tall = perches.filter(p => p.top > 0.8 && p.top < 4.5);
        if (now > m.until && tall.length) {        // the nearest tall thing
          const p = tall.reduce((b, q) => Math.hypot(q.x - a.pos.x, q.z - a.pos.z) < Math.hypot(b.x - a.pos.x, b.z - a.pos.z) ? q : b);
          const d = Math.hypot(a.pos.x - p.x, a.pos.z - p.z) || 1;
          Object.assign(m, { phase: 'go', tx: p.x + (a.pos.x - p.x) / d * p.r, tz: p.z + (a.pos.z - p.z) / d * p.r, top: p.top, px: p.x, pz: p.z, perch: p });
        }
        return there === false;                 // walking (not while arrived, nor blocked)
      }
      if (m.phase === 'go') {
        const there = walkTo(a, m.tx, m.tz, sp * 0.7, dt, env, m.perch);
        if (there === null) { Object.assign(m, { phase: 'roam', until: now + 2, tx: undefined, tz: undefined }); return false; }   // the way is blocked: another time
        if (there) { m.phase = 'up'; a.face = Math.atan2(m.px - a.pos.x, m.pz - a.pos.z); }
        return true;
      }
      if (m.phase === 'up') {
        a.alt = Math.min(m.top, a.alt + dt * 0.6);
        if (a.alt >= m.top) Object.assign(m, { phase: 'sit', until: now + 8 + R() * 6 });
        return true;
      }
      if (m.phase === 'sit') { if (now > m.until) m.phase = 'down'; return false; }
      a.alt = Math.max(0, a.alt - dt * 0.8);       // down
      if (a.alt <= 0) Object.assign(m, { phase: 'roam', until: now + 6 + R() * 5, tx: undefined, tz: undefined });
      return true;
    },
  };
}
