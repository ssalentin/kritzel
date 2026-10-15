// Light and mood: drawn light sources set the scene's time of day and light their surroundings.
// A thing declares itself a light source by returning `light` from build() (see README):
//   sun  → day        moon → night        lamp → a warm light where it stands (fire, candle, lantern)
// With no sun or moon on the sheet the world sits in a soft dusk. Every change eases in over a
// few seconds; nothing snaps.

const PRESETS = {
  // sky: CSS backdrop (centre, middle, edge); env: room-environment light; key: sun/moon light;
  // hemi: sky/ground fill; lamp: how strongly drawn lamps shine in this mood
  day: { sky: ['#d9f1ec', '#bfe3dd', '#a8d4cc'], ink: '#10202e', env: 1, key: [0xfff1dc, 0.9],
    hemi: [0xfff4e6, 0x9cc7b8, 0.15], bounce: 0.25, lamp: 0.35, dir: [6.5, 15.8, -4.5] },
  dusk: { sky: ['#e8ad8a', '#6e5d8c', '#2c2848'], ink: '#fff4ea', env: 0.3, key: [0xff9a55, 0.8],
    hemi: [0xffb98f, 0x3c3a62, 0.3], bounce: 0.1, lamp: 1, dir: [15, 4.5, -6] },
  night: { sky: ['#34487c', '#19244c', '#0b1130'], ink: '#dfe6ff', env: 0.12, key: [0x9db4ff, 0.45],
    hemi: [0x7088c8, 0x141a30, 0.25], bounce: 0.05, lamp: 1.8, dir: [-6, 12, -5] },
};
const LAMP = 5;            // a lamp's light at intensity 1 in a dusk mood (linear falloff:
                           // a lantern up on a post still makes a pool of light on the grass)
const LAMP_SHADOWS = 2;    // point-light shadows are expensive: only the first lamps cast them
const EASE_S = 0.9;        // time constant of every transition (≈ 3 s to settle)

export function createMood({ THREE, scene, key, hemi, bounce }) {
  const C = h => new THREE.Color(h);
  const preset = name => {
    const p = PRESETS[name];
    return { sky: p.sky.map(C), ink: C(p.ink), env: p.env, keyColor: C(p.key[0]), keyInt: p.key[1],
      hemiSky: C(p.hemi[0]), hemiGround: C(p.hemi[1]), hemiInt: p.hemi[2], bounce: p.bounce, lamp: p.lamp,
      dir: new THREE.Vector3(...p.dir) };
  };
  const cur = preset('dusk');
  let name = 'dusk', frame = 0, envApplied = -1;
  const sources = new Map();          // thing id → [{ kind, obj, color, intensity, flicker, pl }]
  const tmp = new THREE.Vector3();

  function forget(id) {
    for (const s of sources.get(id) || []) { s.pl?.removeFromParent(); s.pl?.dispose(); }
    sources.delete(id);
  }

  function assignShadows() {
    let n = 0;
    for (const list of sources.values()) for (const s of list) if (s.pl) s.pl.castShadow = n++ < LAMP_SHADOWS;
  }

  // without an object3D the light sits on top of the thing's middle
  function top(anchor) {
    if (!anchor) return null;
    const box = new THREE.Box3().setFromObject(anchor), o = new THREE.Object3D();
    if (!box.isEmpty()) { box.getCenter(o.position); o.position.y = box.max.y; }
    anchor.add(o);
    return o;
  }

  // the light sources one drawn thing declares; [] removes them. `anchor` stands in for a
  // missing object3D (the thing's own group).
  function set(id, lights, anchor) {
    forget(id);
    const list = [];
    for (const l of lights) {
      if (!l || !['sun', 'moon', 'lamp'].includes(l.kind)) continue;
      const s = { kind: l.kind, obj: l.object3D?.isObject3D ? l.object3D : top(anchor),
        intensity: Number.isFinite(l.intensity) ? Math.max(0, Math.min(l.intensity, 5)) : 1, flicker: !!l.flicker };
      if (s.kind === 'lamp' && s.obj) {
        s.pl = new THREE.PointLight(l.color ?? 0xffa54a, 0, Number.isFinite(l.range) ? l.range : 8, 1);
        s.pl.shadow.mapSize.set(512, 512);
        s.pl.shadow.bias = -0.002;
        s.obj.add(s.pl);
      }
      list.push(s);
    }
    if (list.length) sources.set(id, list);
    assignShadows();
  }

  function update(t, dt) {
    const all = [...sources.values()].flat();
    const sun = all.find(s => s.kind === 'sun'), moon = all.find(s => s.kind === 'moon');
    name = sun ? 'day' : moon ? 'night' : 'dusk';
    const goal = preset(name);
    const body = sun || moon;
    if (body?.obj) {                  // light comes from where the sun or moon hangs
      body.obj.getWorldPosition(tmp);
      if (tmp.lengthSq() > 0.01) goal.dir.copy(tmp).setY(Math.max(tmp.y, 3));
    }

    const k = 1 - Math.exp(-dt / EASE_S);
    cur.sky.forEach((c, i) => c.lerp(goal.sky[i], k));
    for (const f of ['ink', 'keyColor', 'hemiSky', 'hemiGround']) cur[f].lerp(goal[f], k);
    for (const f of ['env', 'keyInt', 'hemiInt', 'bounce', 'lamp']) cur[f] += (goal[f] - cur[f]) * k;
    cur.dir.lerp(goal.dir, k);

    key.color.copy(cur.keyColor);
    key.intensity = cur.keyInt;
    key.position.copy(cur.dir).normalize().multiplyScalar(20);
    hemi.color.copy(cur.hemiSky);
    hemi.groundColor.copy(cur.hemiGround);
    hemi.intensity = cur.hemiInt;
    bounce.intensity = cur.bounce;

    for (const s of all) {
      if (!s.pl) continue;
      const flick = s.flicker ? 1 + 0.08 * Math.sin(t * 13 + s.pl.id) + 0.06 * Math.sin(t * 23.7) : 1;
      const goalI = LAMP * s.intensity * cur.lamp;
      s.base = (s.base ?? 0) + (goalI - (s.base ?? 0)) * k;    // new lamps fade in
      s.pl.intensity = s.base * flick;
    }

    const root = document.documentElement.style;
    cur.sky.forEach((c, i) => root.setProperty(`--sky${i}`, '#' + c.getHexString()));
    root.setProperty('--ink', '#' + cur.ink.getHexString());

    // the room environment gives most of the light: dim it on every material (new things included)
    if (Math.abs(cur.env - envApplied) > 0.002 || ++frame % 30 === 0) {
      envApplied = cur.env;
      scene.traverse(o => { if (o.material) for (const m of [].concat(o.material)) if ('envMapIntensity' in m) m.envMapIntensity = cur.env; });
    }
  }

  return {
    set,
    reset() { for (const id of [...sources.keys()]) forget(id); },
    update,
    get name() { return name; },
  };
}
