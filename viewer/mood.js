// Light and mood: drawn light sources set the scene's time of day and light their surroundings.
// A thing declares itself a light source by returning `light` from build() (see README):
//   sun  → day        moon → night        lamp → a warm light where it stands (fire, candle, lantern)
// With no sun or moon on the sheet the world sits in a soft dusk. Every change eases in over a
// few seconds; nothing snaps. Drawn weather (weather.js) greys and dims the sky on top of that.

import { createWeather } from './weather.js';

const PRESETS = {
  // sky: CSS backdrop (centre, middle, edge); env: room-environment light; key: sun/moon light;
  // hemi: sky/ground fill; lamp: how strongly drawn lamps shine in this mood
  day: { sky: ['#d9f1ec', '#bfe3dd', '#a8d4cc'], ink: '#10202e', env: 1, key: [0xfff1dc, 0.9],
    hemi: [0xfff4e6, 0x9cc7b8, 0.15], bounce: 0.25, lamp: 0.35, night: 0, dir: [6.5, 15.8, -4.5] },
  dusk: { sky: ['#e8ad8a', '#6e5d8c', '#2c2848'], ink: '#fff4ea', env: 0.22, key: [0xff9a55, 1.6],
    hemi: [0xffb98f, 0x3c3a62, 0.18], bounce: 0.1, lamp: 1, night: 0.3, dir: [-15, 4.5, 3] },
  night: { sky: ['#34487c', '#19244c', '#0b1130'], ink: '#dfe6ff', env: 0.12, key: [0x9db4ff, 0.45],
    hemi: [0x7088c8, 0x141a30, 0.25], bounce: 0.05, lamp: 1.8, night: 1, dir: [-6, 12, -5] },
};
const LAMP = 7;            // a lamp's light at intensity 1 in a dusk mood (linear falloff:
                           // a lantern up on a post still makes a pool of light on the grass)
const LAMPS_PER_THING = 3, LAMPS_MAX = 8;   // every lamp is a light the GPU pays for in every material
const LAMP_SHADOWS = 2;    // point-light shadows are expensive: only the first lamps cast them
const EASE_S = 0.9;        // time constant of every transition (≈ 3 s to settle)

export function createMood({ THREE, scene, key, hemi, bounce }) {
  const C = h => new THREE.Color(h);
  const make = name => {
    const p = PRESETS[name];
    return { sky: p.sky.map(C), ink: C(p.ink), env: p.env, keyColor: C(p.key[0]), keyInt: p.key[1],
      hemiSky: C(p.hemi[0]), hemiGround: C(p.hemi[1]), hemiInt: p.hemi[2], bounce: p.bounce, lamp: p.lamp, night: p.night,
      dir: new THREE.Vector3(...p.dir) };
  };
  const presets = Object.fromEntries(Object.keys(PRESETS).map(n => [n, make(n)]));
  const cur = make('dusk'), goalDir = new THREE.Vector3();
  const css = {};                     // last values written, so a settled sky doesn't repaint every frame
  let name = 'dusk', frame = 0, envApplied = -1;
  const sources = new Map();          // thing id → [{ kind, obj, color, intensity, flicker, pl }]
  const tmp = new THREE.Vector3();

  const weather = createWeather({ THREE, scene }), weatherIds = new Set();
  const GREY = [new THREE.Color('#b9bcc6'), new THREE.Color('#7d8291'), new THREE.Color('#4a4e5c')], WHITE = new THREE.Color('#f4f6ff');
  const shown = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  let envShown = 0;

  // a few stars far out, fading in as night falls
  const starPos = [];
  for (let i = 0; i < 160; i++) {
    const a = Math.random() * Math.PI * 2, y = 0.12 + Math.random() * 0.88, r = 70 + Math.random() * 20;
    starPos.push(Math.cos(a) * Math.sqrt(1 - y * y) * r, y * r - 10, Math.sin(a) * Math.sqrt(1 - y * y) * r);
  }
  const starGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xfff6dc, size: 2.2, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false, fog: false }));
  stars.visible = false;
  scene.add(stars);

  function forget(id) {
    for (const s of sources.get(id) || []) { s.pl?.removeFromParent(); s.pl?.dispose(); unglow(s); }
    sources.delete(id);
  }

  // a glowing source shows itself: the meshes it covers get the light's colour as emissive (so night does
  // not dim them), and a soft halo sits on it; a sun or moon gets a bigger corona that pulses. Materials are
  // cloned, so other things that share a material are not touched.
  const GLOW = { sun: { color: 0xffd27a, size: 3.2 }, moon: { color: 0xbfd6ff, size: 2.2 }, lamp: { color: 0xffa54a, size: 1.2 } };
  let haloTex = null;
  function halo(color) {
    if (!haloTex) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const g = cv.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,.5)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
      haloTex = new THREE.CanvasTexture(cv); haloTex.colorSpace = THREE.SRGBColorSpace;
    }
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.5 }));
  }
  function glowOn(s, l, anchor) {
    const kind = GLOW[s.kind], color = new THREE.Color(l.color ?? kind.color);
    const scope = l.object3D?.isObject3D ? l.object3D : anchor;      // the drawn glowing part, or the whole thing
    const meshes = [];
    scope?.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || o.userData.water || o.userData.outline) return;
      if (![].concat(o.material).some(m => m && 'emissive' in m && !m.transparent)) return;
      const orig = o.material, lit = m => ('emissive' in m && !m.transparent) ? m.clone() : m;
      o.material = Array.isArray(orig) ? orig.map(lit) : lit(orig);
      for (const m of [].concat(o.material)) if ('emissive' in m) { m.emissive.copy(color); m.emissiveIntensity = 0; }
      meshes.push({ o, orig });
    });
    const h = halo(color);
    h.scale.setScalar(kind.size);
    s.obj?.add(h);
    s.glow = { color, meshes, halo: h, size: kind.size, phase: Math.random() * 10 };
  }
  function unglow(s) {
    const g = s.glow; if (!g) return;
    for (const { o, orig } of g.meshes) { for (const m of [].concat(o.material)) if (!([].concat(orig).includes(m))) m.dispose(); o.material = orig; }
    g.halo.removeFromParent(); g.halo.material.dispose();
    s.glow = null;
  }

  function assignShadows() {
    let n = 0;
    for (const list of sources.values()) for (const s of list) if (s.pl) s.pl.castShadow = n++ < LAMP_SHADOWS;
  }

  // without an object3D the light sits on top of the thing's middle
  function top(anchor) {
    if (!anchor) return null;
    const box = new THREE.Box3().setFromObject(anchor), o = new THREE.Object3D();
    if (!box.isEmpty()) { box.getCenter(o.position); o.position.y = box.max.y; anchor.worldToLocal(o.position); }
    anchor.add(o);
    return o;
  }

  // the light sources one drawn thing declares; [] removes them. `anchor` stands in for a
  // missing object3D (the thing's own group). Returns how many lamps were left out (too many).
  function set(id, lights, anchor) {
    forget(id);
    const list = [];
    let lamps = [...sources.values()].flat().filter(s => s.pl).length, mine = 0, dropped = 0;
    for (const l of lights) {
      if (!l || !['sun', 'moon', 'lamp'].includes(l.kind)) continue;
      if (l.kind === 'lamp' && (mine >= LAMPS_PER_THING || lamps >= LAMPS_MAX)) { dropped++; continue; }
      const s = { kind: l.kind, obj: l.object3D?.isObject3D ? l.object3D : top(anchor),
        intensity: Number.isFinite(l.intensity) ? Math.max(0, Math.min(l.intensity, 5)) : 1, flicker: !!l.flicker };
      if (s.kind === 'lamp' && s.obj) {
        s.pl = new THREE.PointLight(l.color ?? 0xffa54a, 0, Number.isFinite(l.range) ? Math.max(0.5, Math.min(l.range, 20)) : 8, 1);
        lamps++; mine++;
        s.pl.shadow.mapSize.set(512, 512);
        s.pl.shadow.bias = -0.002;
        s.obj.add(s.pl);
      }
      if (s.obj) glowOn(s, l, anchor);
      list.push(s);
    }
    if (list.length) sources.set(id, list);
    assignShadows();
    return dropped;
  }

  let lastT = 0;
  function update(t, dt) {
    lastT = t;
    const all = [...sources.values()].flat();
    const sun = all.find(s => s.kind === 'sun'), moon = all.find(s => s.kind === 'moon');
    name = sun ? 'day' : moon ? 'night' : 'dusk';
    const goal = presets[name];
    goalDir.copy(goal.dir);
    const body = sun || moon;
    if (body?.obj) {                  // light comes from where the sun or moon hangs
      body.obj.getWorldPosition(tmp);
      if (tmp.lengthSq() > 0.01) goalDir.copy(tmp).setY(Math.max(tmp.y, 3));
    }

    const k = 1 - Math.exp(-dt / EASE_S);
    cur.sky.forEach((c, i) => c.lerp(goal.sky[i], k));
    for (const f of ['ink', 'keyColor', 'hemiSky', 'hemiGround']) cur[f].lerp(goal[f], k);
    for (const f of ['env', 'keyInt', 'hemiInt', 'bounce', 'lamp', 'night']) cur[f] += (goal[f] - cur[f]) * k;
    cur.dir.lerp(goalDir, k);

    const w = weather.update(t, dt);         // rain and storms dim and grey it, lightning flashes
    key.color.copy(cur.keyColor);
    key.intensity = cur.keyInt * (1 - w.dim) + w.flash * 2.5;
    key.position.copy(cur.dir).normalize().multiplyScalar(20);
    hemi.color.copy(cur.hemiSky);
    hemi.groundColor.copy(cur.hemiGround);
    hemi.intensity = cur.hemiInt * (1 - w.dim * 0.5) + w.flash * 1.5;
    bounce.intensity = cur.bounce;
    const starAlpha = Math.max(0, (cur.night - 0.4) / 0.6) * (1 - w.grey);   // clouds hide the stars
    stars.visible = starAlpha > 0.01;
    stars.material.opacity = starAlpha * (0.85 + 0.15 * Math.sin(t * 1.7));
    stars.rotation.y = t * 0.004;

    for (const s of all) {
      if (s.glow) {                       // emissive: brighter at night, flickering for candles and fires
        const g = s.glow, flick = s.flicker ? 1 + 0.12 * Math.sin(t * 13 + g.phase) + 0.08 * Math.sin(t * 23.7) : 1;
        const pulse = s.kind === 'sun' ? 1 + 0.05 * Math.sin(t * 1.2) : s.kind === 'moon' ? 1 + 0.03 * Math.sin(t * 0.7) : 1;
        const lvl = (0.8 + 0.8 * cur.night) * flick * pulse;
        for (const { o } of g.meshes) for (const m of [].concat(o.material)) if ('emissiveIntensity' in m) m.emissiveIntensity = lvl;
        g.halo.material.opacity = (0.3 + 0.35 * cur.night) * flick;
        g.halo.scale.setScalar(g.size * pulse * (1 + 0.1 * cur.night));
      }
      if (!s.pl) continue;
      const flick = s.flicker ? 1 + 0.08 * Math.sin(t * 13 + s.pl.id) + 0.06 * Math.sin(t * 23.7) : 1;
      const goalI = LAMP * s.intensity * cur.lamp;
      s.base = (s.base ?? 0) + (goalI - (s.base ?? 0)) * k;    // new lamps fade in
      s.pl.intensity = s.base * flick * (t < (s.blinkUntil ?? 0) && Math.sin(t * 28) < 0 ? 0.05 : 1);   // tapped: blinks
    }

    cur.sky.forEach((c, i) => shown[i].copy(c).lerp(GREY[i], w.grey * 0.8).lerp(WHITE, w.flash * 0.7));
    const vars = { '--sky0': shown[0], '--sky1': shown[1], '--sky2': shown[2], '--ink': cur.ink };
    for (const [v, c] of Object.entries(vars)) {
      const hex = '#' + c.getHexString();
      if (css[v] !== hex) { css[v] = hex; document.documentElement.style.setProperty(v, hex); }
    }

    // the room environment gives most of the light: dim it on every material (new things included)
    envShown = cur.env * (1 - w.dim) + w.flash * 0.8;
    if (Math.abs(envShown - envApplied) > 0.002 || ++frame % 30 === 0) {
      envApplied = envShown;
      scene.traverse(o => { if (o.material) for (const m of [].concat(o.material)) if ('envMapIntensity' in m) m.envMapIntensity = envShown; });
    }
  }

  return {
    set,
    blink(id) { const until = (lastT ?? 0) + 0.8; for (const s of sources.get(id) || []) if (s.pl) s.blinkUntil = until; },
    reset() { for (const id of [...sources.keys()]) forget(id); for (const id of [...weatherIds]) weather.set(id, []); weatherIds.clear(); },
    // the weather one drawn thing declares ({ kind } or a list; [] removes it)
    setWeather(id, list) { weather.set(id, list); if ([].concat(list || []).length) weatherIds.add(id); else weatherIds.delete(id); },
    weather: () => weather.state(),
    update,
    get name() { return name; },
    get night() { return cur.night; },   // 0 day, ~0.3 dusk, 1 night (eased)
    lamps() {                            // where drawn lamps and fires stand, for the characters
      return [...sources.values()].flat().filter(s => s.pl).map(s => (s.pl.getWorldPosition(tmp), { x: tmp.x, z: tmp.z }));
    },
  };
}
