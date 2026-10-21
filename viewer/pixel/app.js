// The pixel app: the shared book plus per-thing claude-pxl PNGs, with a 32x32 archetype fallback.
// The 3D viewer sends a small world snapshot; no simulation runs on this surface.
import { t } from '../i18n.js';
import { archetype } from './art.js';
import { layoutThings, SCENE } from './layout.js';
import { savePixelMode } from './mode.js';

const canvas = document.getElementById('scene'), ctx = canvas.getContext('2d');
const note = document.getElementById('note'), mode = document.getElementById('renderMode');
const backdrop = new Image(), book = new Image();
const archived = location.pathname.startsWith('/worlds/');
let sceneReady = false, bookReady = false, worldReady = false, expected = 0, dynamic = false, asked = false, items = [];

function draw() {
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
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
  for (const item of items) {
    const r = item.image.width * .48;
    ctx.fillStyle = '#333c57';
    const wide = Math.max(5, Math.round(r * 1.35)), narrow = Math.max(3, Math.round(r * .8));
    ctx.fillRect(Math.round(item.cx - wide / 2), Math.round(item.cy), wide, 2);
    ctx.fillRect(Math.round(item.cx - narrow / 2), Math.round(item.cy + 2), narrow, 1);
    ctx.drawImage(item.image, Math.round(item.cx - item.image.width / 2), Math.round(item.cy - item.image.height));
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

async function loadWorld() {
  if (archived) return;
  try {
    const j = await (await fetch('/api/pixel-snapshot', { cache: 'no-store' })).json();
    window.__pixelSnapshot = j;
    const things = Array.isArray(j.things) ? j.things : [];
    expected = things.length;
    const laidOut = layoutThings(things);
    items = (await Promise.all(laidOut.map(async thing => {
      const base = thing.file.replace(/\.js$/, '');
      const kind = archetype(thing);
      const custom = await imageAt(`sprites/${encodeURIComponent(base)}.png`);
      const fallback = custom ? null : await imageAt(`sprites/fallback-${kind}.png`);
      const image = custom || fallback;
      return image ? { ...thing, kind, image, source: custom ? 'thing' : 'fallback' } : null;
    }))).filter(Boolean);
    worldReady = true;
    dynamic = bookReady && items.length === expected;
    draw();
  } catch { /* archived or offline: the committed fallback scene remains visible */ }
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
const buttons = [...mode.querySelectorAll('button')];
buttons[0].textContent = t('mode3d'); buttons[1].textContent = t('modePixel');
mode.setAttribute('aria-label', t('renderModeGroup'));
note.textContent = t('pixelBuilding');
buttons[0].addEventListener('click', () => { savePixelMode(sessionStorage, false); location.href = '../'; });
buttons[1].addEventListener('click', () => savePixelMode(sessionStorage, true));
window.__pixelApp = {
  draw, rebuild,
  get ready() { return sceneReady; },
  get dynamic() { return dynamic; },
  get items() { return items; },
};

load();
loadWorld();
if (!archived) rebuild();  // only the first new PNG costs a build; the server skips an unchanged scene
