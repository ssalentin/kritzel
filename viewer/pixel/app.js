// The pixel app: the shared book plus per-thing claude-pxl PNGs, with a 32x32 archetype fallback.
// A tiny local motion loop brings actors to life; the 3D simulation is not loaded here.
import { t } from '../i18n.js';
import { archetype } from './art.js';
import { layoutThings, SCENE } from './layout.js';
import { createModeSwitch } from './mode-switch.js';
import { createActor, PAGE, react, stepActor } from './motion.js';

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
const tapSound = new Audio('../sounds/tap.ogg'); tapSound.volume = .35;

function fitCanvas() {
  const w = Math.round(innerWidth * devicePixelRatio), h = Math.round(innerHeight * devicePixelRatio);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function actorDraw(actor, now) {
  const image = actor.thing.image, frames = Math.max(1, Math.round(+actor.thing.frames || 1));
  const frameW = image.width / frames;
  const fps = Math.max(1, +actor.thing.fps || 8);
  const frame = actor.state === 'move' && frames > 1 ? Math.floor(now / 1000 * fps) % frames : 0;
  let dy = 0;
  if (actor.state === 'greet') dy = Math.floor(now / 120) % 2 ? -3 : -2;
  else if (actor.mover === 'hop') dy = -Math.abs(Math.sin(actor.phase)) * 5;
  else if (actor.mover === 'fly') dy = -16 + Math.sin(actor.phase) * 3;
  else if (actor.mover === 'swim') dy = Math.sin(actor.phase * .7) * 2;
  else if (frames === 1 && actor.state === 'idle') dy = Math.floor(now / 380) % 2 ? -1 : 0;
  const y = Math.round(actor.y - image.height + dy);
  const wide = Math.max(5, Math.round(image.width * .62)), narrow = Math.max(3, Math.round(image.width * .36));
  ctx.fillStyle = '#333c57';
  ctx.fillRect(Math.round(actor.x - wide / 2), Math.round(actor.y), wide, 2);
  ctx.fillRect(Math.round(actor.x - narrow / 2), Math.round(actor.y + 2), narrow, 1);
  ctx.save();
  ctx.translate(Math.round(actor.x), 0);
  ctx.scale(actor.facing, 1);
  if (actor.mover === 'walk' && actor.state === 'move' && frames === 1) {
    // A one-frame sprite still walks: the body bobs while the lower left/right halves alternate like planted legs.
    const legH = Math.max(4, Math.round(image.height * .3)), bodyH = image.height - legH;
    const swing = Math.sin(actor.phase), bob = Math.abs(swing) > .72 ? -1 : 0;
    const leftW = Math.floor(frameW / 2), rightW = frameW - leftW;
    ctx.drawImage(image, 0, 0, frameW, bodyH, Math.round(-frameW / 2), y + bob, frameW, bodyH);
    ctx.drawImage(image, 0, bodyH, leftW, legH, Math.round(-frameW / 2 + swing * 1.5), y + bodyH - (swing > 0 ? 1 : 0),
      leftW, legH);
    ctx.drawImage(image, leftW, bodyH, rightW, legH, Math.round(-frameW / 2 + leftW - swing * 1.5), y + bodyH - (swing < 0 ? 1 : 0),
      rightW, legH);
  } else ctx.drawImage(image, frame * frameW, 0, frameW, image.height, Math.round(-frameW / 2), y, frameW, image.height);
  ctx.restore();
}

// A dragon breathes fire on tap: a short cone of pixel flames from the mouth.
function fireDraw(actor, now) {
  const face = actor.facing || 1, w = actor.thing.image.width, h = actor.thing.image.height;
  const mouthX = Math.round(actor.x + face * w * .34);
  const mouthY = Math.round(actor.y - h * .52);
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

// Day sky: a pixel sun with rays, and snow falling across the whole scene.
const flakes = Array.from({ length: 70 }, (_, i) => {
  let s = (i + 1) * 2654435761 >>> 0;
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const x = s / 4294967296;
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const y = s / 4294967296;
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const v = 14 + (s / 4294967296) * 26;
  return { x: x * SCENE.w, y: y * SCENE.h, v, drift: (x - .5) * 8 };
});
function weatherDraw(now) {
  const cx = SCENE.w - 26, cy = 16;
  ctx.fillStyle = '#ffcd75';
  for (const [dx, dy] of [[0,-11],[8,-8],[11,0],[8,8],[0,11],[-8,8],[-11,0],[-8,-8]]) {
    ctx.fillRect(cx + dx - 1, cy + dy - 1, 2, 2);
  }
  ctx.fillStyle = '#ffcd75'; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffec9e'; ctx.fillRect(cx - 3, cy - 3, 3, 2);
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
    const r = item.image.width * .48;
    ctx.fillStyle = '#333c57';
    const wide = Math.max(5, Math.round(r * 1.35)), narrow = Math.max(3, Math.round(r * .8));
    ctx.fillRect(Math.round(item.cx - wide / 2), Math.round(item.cy), wide, 2);
    ctx.fillRect(Math.round(item.cx - narrow / 2), Math.round(item.cy + 2), narrow, 1);
    ctx.drawImage(item.image, Math.round(item.cx - item.image.width / 2), Math.round(item.cy - item.image.height));
  }
  for (const actor of actors) {
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
      const fallback = custom ? null : await imageAt(`sprites/fallback-${form}.png`);
      const image = custom || fallback;
      return image ? { ...thing, form, image, source: custom ? 'thing' : 'fallback' } : null;
    }))).filter(Boolean);
    worldReady = true;
    dynamic = bookReady && items.length === expected;
    obstacles = items.filter(i => i.kind !== 'actor').map(i => ({
      x: i.cx, y: i.cy, w: Math.max(12, i.image.width * .7), h: Math.max(10, i.image.height), kind: i.form,
    }));
    scenery = items.filter(i => i.kind !== 'actor');
    actors = items.filter(i => i.kind === 'actor').map((i, n) =>
      createActor({ ...i, x: i.cx, y: i.cy, speed: i.speed }, n));
    draw();
    if (actors.length && !animationStarted) { animationStarted = true; requestAnimationFrame(animate); }
    return true;
  } catch { /* offline: the committed fallback scene remains visible */ }
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

canvas.addEventListener('pointerdown', event => {
  // TODO: hand carry/pickup has no pixel-side equivalent yet; taps only greet for this slice.
  if (!actors.length) return;
  const rect = canvas.getBoundingClientRect();
  const px = (event.clientX - rect.left) * canvas.width / rect.width;
  const py = (event.clientY - rect.top) * canvas.height / rect.height;
  const s = Math.min(canvas.width / SCENE.w, canvas.height / SCENE.h);
  const x = (px - (canvas.width - SCENE.w * s) / 2) / s, y = (py - (canvas.height - SCENE.h * s) / 2) / s;
  const hit = actors.slice().reverse().find(a => x >= a.x - a.thing.image.width / 2 && x <= a.x + a.thing.image.width / 2
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

function animate(now) {
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  let moved = false;
  for (const actor of actors) moved = stepActor(actor, dt, obstacles, PAGE) || moved;
  const pulse = actors.some(a => a.state === 'greet' || a.fireUntil > now || (a.state === 'idle' && (+a.thing.frames || 1) === 1));
  if (moved || pulse || now - lastIdleDraw > 50) { draw(now); lastIdleDraw = now; }
  requestAnimationFrame(animate);
}

load();
loadWorld();
if (!archived) rebuild();  // only the first new PNG costs a build; the server skips an unchanged scene
if (!archived) setInterval(() => loadWorld(), 1000);
