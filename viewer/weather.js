// Weather you can draw: a thing returns weather: { kind: 'rain'|'snow'|'rainbow'|'lightning' }
// (or a list) and the sky does it for as long as the thing is on the island. mood.js owns this:
// it calls update() every frame and applies the returned dimming, greying and lightning flash to
// the sky and lights. Every effect eases in and out; nothing snaps.

const KINDS = ['rain', 'snow', 'rainbow', 'lightning'];
const EASE_S = 1.5;

export function createWeather({ THREE, scene }) {
  const wanted = new Map();                    // thing id → Set of kinds
  const level = { rain: 0, snow: 0, rainbow: 0, lightning: 0 };
  let flash = 0, nextBolt = 3, wet = 0;
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(11);

  // rain: short streaks falling fast over the island
  const nRain = 600, rainPos = new Float32Array(nRain * 6), drops = [];
  for (let i = 0; i < nRain; i++) drops.push({ x: (rnd() - 0.5) * 18, z: (rnd() - 0.5) * 18, y: rnd() * 12, v: 9 + rnd() * 3 });
  const rain = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(rainPos, 3)),
    new THREE.LineBasicMaterial({ color: 0xbcd6ff, transparent: true, opacity: 0, depthWrite: false }));
  rain.frustumCulled = false;

  // snow: flakes drifting down slowly
  const nSnow = 450, snowPos = new Float32Array(nSnow * 3), flakes = [];
  for (let i = 0; i < nSnow; i++) flakes.push({ x: (rnd() - 0.5) * 18, z: (rnd() - 0.5) * 18, y: rnd() * 12, v: 0.6 + rnd() * 0.6, p: rnd() * 6 });
  const snow = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(snowPos, 3)),
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0, depthWrite: false }));
  snow.frustumCulled = false;

  // puddles that grow on the grass while it rains and dry up after
  const puddles = new THREE.Group();
  const puddleMat = new THREE.MeshStandardMaterial({ color: 0x6f8fb8, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0, depthWrite: false });
  for (let i = 0; i < 7; i++) {
    const a = rnd() * Math.PI * 2, r = 1 + rnd() * 4.5;
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.35 + rnd() * 0.45, 20), puddleMat);
    m.rotation.x = -Math.PI / 2; m.scale.set(1, 0.6 + rnd() * 0.4, 1);
    m.position.set(Math.cos(a) * r, 0.03, Math.sin(a) * r);
    puddles.add(m);
  }

  // rainbow: seven bands, a big arc behind the island
  const rainbow = new THREE.Group();
  [0xff5a5a, 0xff9f40, 0xffe24a, 0x6fd26f, 0x5ab4ff, 0x6a6cff, 0xb36bff].forEach((c, i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(9 - i * 0.32, 0.17, 6, 64, Math.PI),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    rainbow.add(m);
  });
  rainbow.position.set(0, -1.5, -8);

  // lightning: a jagged bolt from the sky to a spot on the island, for a moment
  const boltPos = new Float32Array(12 * 3);
  const bolt = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(boltPos, 3)),
    new THREE.LineBasicMaterial({ color: 0xfffbe0, transparent: true, opacity: 0, toneMapped: false }));
  bolt.frustumCulled = false;

  scene.add(rain, snow, puddles, rainbow, bolt);

  function set(id, list) {
    const kinds = new Set([].concat(list || []).map(w => typeof w === 'string' ? w : w?.kind).filter(k => KINDS.includes(k)));
    if (kinds.size) wanted.set(id, kinds); else wanted.delete(id);
  }
  const active = () => new Set([...wanted.values()].flatMap(s => [...s]));

  function strike() {
    let x = (rnd() - 0.5) * 8, z = (rnd() - 0.5) * 8;
    for (let i = 0; i < 12; i++) {
      const y = 11 - i;
      boltPos.set([x, y, z], i * 3);
      x += (rnd() - 0.5) * 0.9; z += (rnd() - 0.5) * 0.9;
    }
    bolt.geometry.attributes.position.needsUpdate = true;
    flash = 1;
  }

  // returns what mood.js applies: dim (0-1 less light), grey (0-1 toward a grey sky), flash (0-1)
  function update(t, dt) {
    const on = active(), k = 1 - Math.exp(-dt / EASE_S);
    for (const kind of KINDS) level[kind] += ((on.has(kind) ? 1 : 0) - level[kind]) * k;

    rain.material.opacity = 0.55 * level.rain;
    rain.visible = level.rain > 0.01;
    if (rain.visible) drops.forEach((d, i) => {
      d.y -= d.v * dt;
      if (d.y < 0) { d.y = 11 + rnd() * 2; d.x = (rnd() - 0.5) * 18; d.z = (rnd() - 0.5) * 18; }
      rainPos.set([d.x, d.y, d.z, d.x - 0.03, d.y + 0.35, d.z], i * 6);
    });
    rain.geometry.attributes.position.needsUpdate = rain.visible;

    snow.material.opacity = 0.9 * level.snow;
    snow.visible = level.snow > 0.01;
    if (snow.visible) flakes.forEach((f, i) => {
      f.y -= f.v * dt;
      if (f.y < 0) { f.y = 11 + rnd() * 2; f.x = (rnd() - 0.5) * 18; f.z = (rnd() - 0.5) * 18; }
      snowPos.set([f.x + Math.sin(t * 0.8 + f.p) * 0.3, f.y, f.z + Math.cos(t * 0.6 + f.p) * 0.3], i * 3);
    });
    snow.geometry.attributes.position.needsUpdate = snow.visible;

    wet += ((level.rain > 0.5 ? 1 : 0) - wet) * (1 - Math.exp(-dt / (level.rain > 0.5 ? 12 : 30)));   // puddles grow, then dry
    puddleMat.opacity = 0.55 * wet;
    puddles.visible = wet > 0.01;

    rainbow.visible = level.rainbow > 0.01;
    rainbow.children.forEach(m => { m.material.opacity = 0.75 * level.rainbow; });

    flash = Math.max(0, flash - dt * 4);       // fade the last flash first, so a new strike shows at full 1
    if (level.lightning > 0.5 && (nextBolt -= dt) <= 0) { strike(); nextBolt = 4 + rnd() * 7; }
    bolt.material.opacity = flash > 0.6 ? 1 : 0;
    bolt.visible = flash > 0.6;

    return {
      dim: Math.max(level.rain * 0.35, level.lightning * 0.45, level.snow * 0.1),
      grey: Math.max(level.rain, level.lightning) * 0.55 + level.snow * 0.35,
      flash,
    };
  }

  return {
    set, update,
    // for the characters: what is going on, and when lightning last struck
    state: () => ({ rain: level.rain > 0.5, snow: level.snow > 0.5, rainbow: level.rainbow > 0.5, lightning: level.lightning > 0.5, flash }),
  };
}
