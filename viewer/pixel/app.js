// The pixel app: the shared book plus per-thing claude-pxl PNGs, with a 32x32 archetype fallback.
// A tiny local motion loop brings actors to life; the 3D simulation is not loaded here.
import { t } from '../i18n.js';
import Matter from 'matter-js';
import { archetype } from './art.js';
import { stripFrame } from './animation.js';
import { layoutThings, SCENE } from './layout.js';
import { createModeSwitch } from './mode-switch.js';
import { createActor, moverFor, PAGE, react, stepActor } from './motion.js';
import { createPhysics, HOLD_LIFT } from './physics.js';
const MatterAPI = Matter.Matter || Matter;

const canvas = document.getElementById('scene'), ctx = canvas.getContext('2d');
const note = document.getElementById('note'), mode = document.getElementById('renderMode');
const actorCard = document.getElementById('actorCard');
const backdrop = new Image(), book = new Image();
const archived = location.pathname.startsWith('/worlds/');
const activeMode = await fetch(archived ? '../world-mode.json' : '/api/world-mode', { cache: 'no-store' })
  .then(r => r.ok ? r.json() : { render: '3d' }).then(m => m.render).catch(() => '3d');
if (activeMode !== 'pixel') {
  location.replace('../');
  await new Promise(() => {});
}
let sceneReady = false, bookReady = false, worldReady = false, expected = 0, dynamic = false, asked = false, items = [];
let thingsVersion = '', loadingWorld = null;
let actors = [], obstacles = [], scenery = [], lastFrame = 0, lastIdleDraw = 0, cardTimer = 0, animationStarted = false;
let physics = null, heldPointer = null;
const tapSound = new Audio('../sounds/tap.ogg'); tapSound.volume = .35;

function fitCanvas() {
  const w = Math.round(innerWidth * devicePixelRatio), h = Math.round(innerHeight * devicePixelRatio);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function actorFrameWidth(actor) {
  return stripFrame(actor.thing.image.width, actor.thing.image.height,
    { frames: actor.thing.frames }).width;
}

function isPortableThing(thing) {
  if (thing.kind === 'actor') return false;
  if (typeof thing.portable === 'boolean') return thing.portable;
  return ['flower', 'cookie', 'chest', 'lamp', 'blob'].includes(thing.form);
}

function itemFrameWidth(item) {
  return stripFrame(item.image.width, item.image.height, { frames: item.frames }).width;
}

function itemDraw(item, now) {
  const frame = stripFrame(item.image.width, item.image.height,
    { frames: item.frames, fps: item.fps, state: 'idle', now });
  const body = physics?.portableBodies.get(item);
  if (!body) {
    ctx.drawImage(item.image, frame.index * frame.width, 0, frame.width, item.image.height,
      Math.round(item.cx - frame.width / 2), Math.round(item.cy - item.image.height), frame.width, item.image.height);
    return;
  }
  const q = Math.PI / 12, angle = Math.round(body.angle / q) * q;
  ctx.save();
  ctx.translate(Math.round(body.position.x), Math.round(body.position.y));
  ctx.rotate(angle);
  ctx.drawImage(item.image, frame.index * frame.width, 0, frame.width, item.image.height,
    -Math.round(frame.width / 2), -Math.round(item.image.height / 2), frame.width, item.image.height);
  ctx.restore();
}

function actorDraw(actor, now) {
  const image = actor.thing.image;
  const strip = stripFrame(image.width, image.height,
    { frames: actor.thing.frames, fps: actor.thing.fps, state: actor.state, now });
  const frames = strip.count, frameW = strip.width, frame = strip.index;
  let dy = 0;
  if (actor.state === 'greet') dy = Math.floor(now / 120) % 2 ? -3 : -2;
  else if (actor.mover === 'hop') dy = -Math.abs(Math.sin(actor.phase)) * 5;
  else if (actor.mover === 'fly') dy = -16 + Math.sin(actor.phase) * 3;
  else if (actor.mover === 'swim') dy = Math.sin(actor.phase * .7) * 2;
  else if (actor.mover === 'walk' && actor.state === 'move' && frames === 1) dy = Math.floor(actor.phase * 2) % 2 ? -1 : 0;
  else if (frames === 1 && actor.state === 'idle') dy = Math.floor(now / 380) % 2 ? -1 : 0;
  const y = Math.round(actor.y - image.height + dy);
  const wide = Math.max(5, Math.round(frameW * .62)), narrow = Math.max(3, Math.round(frameW * .36));
  ctx.fillStyle = '#333c57';
  ctx.fillRect(Math.round(actor.x - wide / 2), Math.round(actor.y), wide, 2);
  ctx.fillRect(Math.round(actor.x - narrow / 2), Math.round(actor.y + 2), narrow, 1);
  ctx.save();
  ctx.translate(Math.round(actor.x), 0);
  ctx.scale(actor.facing, 1);
  ctx.drawImage(image, frame * frameW, 0, frameW, image.height, Math.round(-frameW / 2), y, frameW, image.height);
  ctx.restore();
}

// A dragon breathes fire on tap: a short cone of pixel flames from the mouth.
function fireDraw(actor, now) {
  const face = actor.facing || 1, w = actor.thing.image.width, h = actor.thing.image.height;
  const mouthX = Math.round(actor.x + face * w * .34);
  const mouthY = Math.round(actor.y - h * .52);
  const flicker = .16 + Math.abs(Math.sin(now / 90)) * .08;
  pxEllipse(mouthX + face * 12, mouthY - 1, 16, 9, '#ff7a2a', flicker);
  pxEllipse(mouthX + face * 9, mouthY - 1, 10, 6, '#ffd36b', flicker + .06);
  let seed = (Math.floor(now / 70) + 1) * 2654435761 >>> 0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 9; i++) {
    const x = mouthX + Math.round(face * i * 3);
    const tall = Math.max(1, 5 - Math.floor(i / 2) + Math.round(rnd() * 2));
    ctx.fillStyle = i < 3 ? '#fff6e0' : i < 6 ? '#ffa733' : '#e84a2a';
    ctx.fillRect(x, mouthY - tall, 3, tall);
  }
  ctx.fillStyle = '#7c8794';
  ctx.fillRect(mouthX + Math.round(face * 27), mouthY - 9, 3, 3);
  ctx.fillRect(mouthX + Math.round(face * 32), mouthY - 13, 2, 2);
}

// A hard-edged ellipse made of 1px rows (no canvas anti-aliasing).
function pxEllipse(cx, cy, rx, ry, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let dy = -ry; dy <= ry; dy++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))));
    if (w > 0) ctx.fillRect(Math.round(cx - w), Math.round(cy + dy), w * 2, 1);
  }
  ctx.restore();
}

// Shadows fall away from the sun (top-left), and a warm halo surrounds it.
function sunShadow(x, y, w) {
  pxEllipse(x + 5, y + 2, Math.max(4, w * .42), 3, '#14101f', .22);
  pxEllipse(x + 7, y + 3, Math.max(3, w * .3), 2, '#14101f', .14);
}

// Day sky: a pixel sun with rays, and snow falling across the whole scene.
const flakes = Array.from({ length: 70 }, (_, i) => {
  let s = (i + 1) * 2654435761 >>> 0;
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const x = s / 4294967296;
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const y = s / 4294967296;
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const v = 14 + (s / 4294967296) * 26;
  return { x: x * SCENE.w, y: y * SCENE.h, v, drift: (x - .5) * 8 };
});
function weatherDraw(now) {
  const cx = 34, cy = 22;
  pxEllipse(cx, cy, 22, 18, '#ffd36b', .10);
  const R = 8;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R + 2) continue;
      ctx.fillStyle = dx < -2 && dy < -2 ? '#ffec9e' : '#ffcd75';
      ctx.fillRect(cx + dx, cy + dy, 1, 1);
    }
  }
  ctx.fillStyle = '#ffcd75';
  for (const [dx, dy] of [[0,-13],[10,-10],[13,0],[10,10],[0,13],[-10,10],[-13,0],[-10,-10]]) {
    ctx.fillRect(cx + dx - 1, cy + dy - 1, 2, 2);
  }
  const t = now / 1000;
  ctx.fillStyle = '#fff6e0';
  for (const f of flakes) {
    const y = (f.y + t * f.v) % SCENE.h;
    const x = (f.x + Math.sin(t * .6 + f.y) * f.drift + SCENE.w) % SCENE.w;
    ctx.fillRect(Math.round(x), Math.round(y), 1, 2);
  }
}

function draw(now = performance.now()) {
  fitCanvas();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#29366f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const image = dynamic && bookReady ? book : sceneReady ? backdrop : null;
  if (!image) return;
  const s = Math.min(canvas.width / SCENE.w, canvas.height / SCENE.h);
  const ox = (canvas.width - SCENE.w * s) / 2, oy = (canvas.height - SCENE.h * s) / 2;
  ctx.drawImage(image, ox, oy, SCENE.w * s, SCENE.h * s);
  if (image !== book) return;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  ctx.imageSmoothingEnabled = false;
  weatherDraw(now);
  for (const item of scenery) {
    const body = physics?.portableBodies.get(item), footX = body?.position.x ?? item.cx;
    const footY = body ? body.position.y + item.image.height / 2 : item.cy;
    const held = physics?.held === item;
    sunShadow(footX, footY + (held ? HOLD_LIFT : 0), itemFrameWidth(item) * (held ? 1.25 : 1));
    const r = itemFrameWidth(item) * .48;
    ctx.fillStyle = '#333c57';
    const wide = Math.max(5, Math.round(r * 1.35)), narrow = Math.max(3, Math.round(r * .8));
    ctx.fillRect(Math.round(footX - wide / 2), Math.round(footY + (held ? HOLD_LIFT : 0)), wide, 2);
    ctx.fillRect(Math.round(footX - narrow / 2), Math.round(footY + (held ? HOLD_LIFT : 0) + 2), narrow, 1);
    itemDraw(item, now);
  }
  for (const actor of actors) {
    sunShadow(actor.x, actor.y + 1, actorFrameWidth(actor));
    actorDraw(actor, now);
    if (actor.fireUntil > now) fireDraw(actor, now);
  }
  ctx.restore();
}

function load(stamp = '') {
  const q = stamp ? '?v=' + stamp : '';
  sceneReady = false;
  bookReady = false;
  dynamic = false;
  backdrop.src = 'scenes/kritzel.png' + q;
  book.src = 'scenes/book.png' + q;
}
backdrop.onload = () => { sceneReady = true; note.hidden = true; draw(); };
backdrop.onerror = () => { note.hidden = false; if (!archived) rebuild(); };
book.onload = () => { bookReady = true; dynamic = worldReady && items.length === expected; draw(); };

function imageAt(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function loadWorld(force = false) {
  if (loadingWorld) return loadingWorld;
  loadingWorld = loadWorldOnce(force).finally(() => { loadingWorld = null; });
  return loadingWorld;
}

async function loadWorldOnce(force) {
  try {
    let things;
    if (archived) {
      const listing = await (await fetch('things/', { cache: 'no-store' })).text();
      const files = [...listing.matchAll(/href="([\w.-]+\.json)"/g)].map(m => m[1]);
      if (!files.length) return;
      things = await Promise.all(files.map(f => fetch('things/' + f, { cache: 'no-store' })
        .then(r => r.json()).then(t => ({ ...t, file: f }))));
    } else {
      const j = await (await fetch('/api/pixel-things', { cache: 'no-store' })).json();
      if (!force && j.version && j.version === thingsVersion) return false;
      thingsVersion = j.version || '';
      things = j.things || [];
    }
    window.__pixelThings = things;
    expected = things.length;
    dynamic = false;                     // things changed: the drawn scene is stale until items are rebuilt
    const laidOut = layoutThings(things);
    items = (await Promise.all(laidOut.map(async thing => {
      const base = thing.file.replace(/\.json$/, '');
      const form = archetype(thing);
      const sprite = thing.sprite && /^[\w.-]+\.png$/.test(thing.sprite) ? thing.sprite : `${base}.png`;
      const custom = await imageAt(`things/${encodeURIComponent(sprite)}`);
      const walkFallback = !custom && form === 'person' && moverFor(thing) === 'walk'
        ? await imageAt('sprites/fallback-person-walk.png') : null;
      const fallback = custom || walkFallback ? null : await imageAt(`sprites/fallback-${form}.png`);
      const image = custom || walkFallback || fallback;
      const animatedFallback = !custom && walkFallback;
      const frames = animatedFallback ? 4 : thing.frames, fps = animatedFallback ? 10 : thing.fps;
      const frameW = image ? stripFrame(image.width, image.height, { frames }).width : 0;
      const item = image ? { ...thing, form, image, source: custom ? 'thing' : animatedFallback ? 'fallback-strip' : 'fallback',
        frames, fps, w: Math.max(8, frameW * .72), h: Math.max(8, image.height * .72) } : null;
      if (item) item.portable = isPortableThing(item);
      return item;
    }))).filter(Boolean);
    worldReady = true;
    dynamic = bookReady && items.length === expected;
    scenery = items.filter(i => i.kind !== 'actor');
    const solid = scenery.filter(i => !i.portable), portable = scenery.filter(i => i.portable);
    obstacles = solid.map(i => ({ x: i.cx, y: i.cy, w: i.w, h: i.h, kind: i.form }));
    actors = items.filter(i => i.kind === 'actor').map((i, n) =>
      createActor({ ...i, x: i.cx, y: i.cy, speed: i.speed, radius: Math.max(4, itemFrameWidth(i) * .23) }, n));
    physics = createPhysics(MatterAPI, {
      bounds: PAGE,
      statics: solid.map(i => ({ ...i, w: i.w, h: i.h })),
      portables: portable,
      actors,
    });
    window.__pixelPhysics = physics;
    draw();
    if ((actors.length || physics.portableBodies.size) && !animationStarted) {
      animationStarted = true;
      requestAnimationFrame(animate);
    }
    return true;
  } catch (error) {
    console.error('pixel world:', error);
    note.hidden = false;
    note.textContent = `Pixel-Welt: ${error.message}`;
  }
  return false;
}

function rebuild() {
  if (asked) return;
  asked = true;
  fetch('/api/pixel-world', { method: 'POST', headers: { 'X-Kritzel': '1' } })
    .then(r => r.json())
    .then(j => {
      if (!j.ok || !j.built) return;
      load(Date.now());
      loadWorld();
    })
    .catch(() => { asked = false; });
}

addEventListener('resize', draw);
note.textContent = t('pixelBuilding');
createModeSwitch({
  active: 'pixel', group: mode, archived,
  go: () => { location.href = '../'; },
  onError: () => { note.hidden = false; note.textContent = t('modeFailed'); },
});
window.__pixelApp = {
  draw, rebuild,
  get ready() { return sceneReady; },
  get dynamic() { return dynamic; },
  get items() { return items; },
  get actors() { return actors; },
  get obstacles() { return obstacles; },
};

function scenePoint(event) {
  const rect = canvas.getBoundingClientRect();
  const px = (event.clientX - rect.left) * canvas.width / rect.width;
  const py = (event.clientY - rect.top) * canvas.height / rect.height;
  const s = Math.min(canvas.width / SCENE.w, canvas.height / SCENE.h);
  return { x: (px - (canvas.width - SCENE.w * s) / 2) / s, y: (py - (canvas.height - SCENE.h * s) / 2) / s };
}

canvas.addEventListener('pointerdown', event => {
  const point = scenePoint(event);
  const body = physics?.portableAt(point);
  if (body) {
    heldPointer = event.pointerId;
    canvas.setPointerCapture(heldPointer);
    physics.grab(body, point);
    tapSound.currentTime = 0;
    tapSound.play().catch(() => {});
    draw();
    return;
  }
  const { x, y } = point;
  const hit = actors.slice().reverse().find(a => x >= a.x - actorFrameWidth(a) / 2 && x <= a.x + actorFrameWidth(a) / 2
    && y >= a.y - a.thing.image.height - 4 && y <= a.y + 6);
  if (!hit) return;
  react(hit);
  const dragon = /drache|dragon/i.test(`${hit.thing.name || ''} ${hit.thing.drawing || ''}`);
  if (dragon) hit.fireUntil = performance.now() + 1000;
  actorCard.firstElementChild.textContent = hit.thing.name || hit.id;
  actorCard.lastElementChild.textContent = dragon ? 'Feuer!' : t('pixelHello');
  actorCard.hidden = false;
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => { actorCard.hidden = true; }, 1400);
  tapSound.currentTime = 0;
  tapSound.play().catch(() => {});
  draw();
});

canvas.addEventListener('pointermove', event => {
  if (heldPointer !== event.pointerId || !physics?.held) return;
  physics.moveHeld(scenePoint(event), event.timeStamp || performance.now());
  draw();
});

function dropHeld(event) {
  if (heldPointer !== event.pointerId || !physics?.held) return;
  physics.releaseHeld(event.timeStamp || performance.now());
  heldPointer = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  draw();
}
canvas.addEventListener('pointerup', dropHeld);
canvas.addEventListener('pointercancel', dropHeld);

function animate(now) {
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  let moved = false;
  for (const actor of actors) moved = stepActor(actor, dt, obstacles, PAGE) || moved;
  const physical = physics?.step(dt);
  const pulse = actors.some(a => a.state === 'greet' || a.fireUntil > now || (a.state === 'idle' && (+a.thing.frames || 1) === 1));
  if (moved || physical?.moved || pulse || now - lastIdleDraw > 50) { draw(now); lastIdleDraw = now; }
  requestAnimationFrame(animate);
}

load();
loadWorld();
if (!archived) rebuild();  // only the first new PNG costs a build; the server skips an unchanged scene
if (!archived) setInterval(() => loadWorld(), 1000);
