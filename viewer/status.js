// What the pipeline is doing, for the person at the paper: a small pill in the corner (from
// GET /api/status, written by capture and generate) and, the moment a new drawing is seen, a
// warm glowing light on the free spot of the island where its 3D thing will grow out of it.

const RESULT_S = 10;       // how long "✓ neu: …" / "✗ nicht erkannt" stays up
const SEEN_S = 6;          // how long "✏️ neue Zeichnung erkannt" stays up (if generate is slower to start)
const IDLE_S = 4;          // a calm pill folds to a dot after this long
const LIGHT_MAX_S = 120;   // a light whose thing never arrives (generator running) goes away after this long

// a soft round glow for the light's halo, drawn once
function glowTexture(THREE) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,240,200,1)'); grad.addColorStop(0.35, 'rgba(255,190,110,.55)'); grad.addColorStop(1, 'rgba(255,160,80,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createStatus({ THREE, scene, el, world }) {
  const dot = el.querySelector('.dot'), text = el.querySelector('.text'), img = el.querySelector('img'), gen = el.querySelector('.gen');
  let st = null, lastView = '', viewSince = 0, prevCap = null, connectedAt = 0;
  const lights = new Map();          // frame → { g, light, orb, halo, sparks, spot, born, dying, claimed }
  const glow = glowTexture(THREE);
  const growing = [];                // things that just arrived, growing out of their light

  // where generate puts a thing for this changed_box (same mapping as generate/generate.mjs cropOf),
  // and roughly how much room it will need
  function placeOf({ box: [x, y, w, h], width: W, height: H }) {
    let ix = ((x + w / 2) / W - 0.5) * 9, iz = ((y + h / 2) / H - 0.5) * 7;
    const r = Math.hypot(ix, iz);
    if (r > 5) { ix *= 5 / r; iz *= 5 / r; }
    return { x: ix, z: iz, r: Math.min(1.8, Math.max(0.6, (Math.max(w / W, h / H)) * 4.5 * 0.4)) };
  }

  function addLight(last) {
    const want = placeOf(last);
    const spot = world()?.freeSpot?.(want.x, want.z, want.r) || want;
    const g = new THREE.Group();
    g.position.set(spot.x, 0, spot.z);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffe2a8, toneMapped: false }));
    orb.position.y = 0.8;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    halo.position.y = 0.8;
    halo.scale.setScalar(1.6);
    const light = new THREE.PointLight(0xffb866, 0, 4.5, 1);
    light.position.y = 0.9;
    const n = 18, pos = new Float32Array(n * 3), seeds = [];
    for (let i = 0; i < n; i++) seeds.push({ a: Math.random() * 6.28, r: 0.1 + Math.random() * 0.35, t0: Math.random() * 1.6 });
    const sparks = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ color: 0xffd38a, size: 0.07, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sparks.userData.seeds = seeds;
    g.add(orb, halo, light, sparks);
    g.scale.setScalar(0.001);
    scene.add(g);
    lights.set(last.frame, { g, light, orb, halo, sparks, spot: { ...spot, r: want.r }, born: performance.now(), dying: 0, claimed: false });
  }

  function retire(frame) {
    const l = lights.get(frame);
    if (l && !l.dying) l.dying = performance.now();
  }

  function drop(frame) {
    const l = lights.get(frame);
    scene.remove(l.g);
    l.orb.geometry.dispose(); l.orb.material.dispose(); l.halo.material.dispose(); l.sparks.geometry.dispose(); l.sparks.material.dispose();
    lights.delete(frame);
  }

  // the pill's text for this moment, from both stages' status files
  function view(now) {
    const c = st?.capture || {}, g = st?.generate || {}, last = c.last;
    const thumb = last?.cutout && now - last.at < 300 ? last.frame : null;
    if (g.alive && g.state === 'building') return { tone: 'busy', text: `🎨 wird gebaut… ${Math.max(0, Math.round(now - g.since))} s`, thumb };
    if (g.alive && now - g.since < RESULT_S) {
      if (g.state === 'new') return { tone: 'ok', text: `✓ neu: ${g.detail || 'Ding'}`, thumb };
      if (g.state === 'changed') return { tone: 'ok', text: `↻ geändert: ${g.detail || 'Ding'}`, thumb };
      if (g.state === 'unclear' || g.state === 'failed') return { tone: 'warn', text: '✗ nicht erkannt', thumb };
    }
    if (last && now - last.at < SEEN_S) return { tone: 'busy', text: '✏️ neue Zeichnung erkannt', thumb };
    if (!c.alive) return { tone: 'bad', text: '⚠ Kamera-Beobachter aus' };
    if (c.state === 'camera-off') return { tone: 'bad', text: 'Kamera aus' };
    if (c.state === 'no-camera') return { tone: 'bad', text: 'keine Kamera gewählt' };
    if (c.state === 'moving') return { tone: 'ok', text: '✋ Bewegung…' };
    if (now - connectedAt < 3) return { tone: 'ok', text: 'Kamera verbunden' };
    return { tone: 'ok', text: '👀 beobachtet das Papier', calm: true };
  }

  function render() {
    if (!st) return;
    const now = st.now + (performance.now() - st.at) / 1000;   // server clock, ticking between polls
    const v = view(now);
    const key = v.text.replace(/\d+ s$/, '');
    if (key !== lastView) { lastView = key; viewSince = performance.now(); }
    el.dataset.tone = v.tone;
    el.classList.toggle('calm', !!v.calm && performance.now() - viewSince > IDLE_S * 1000);
    if (text.textContent !== v.text) text.textContent = v.text;
    const src = v.thumb ? `/api/status/cutout.png?v=${encodeURIComponent(v.thumb)}` : '';
    if (img.getAttribute('src') !== src) { if (src) img.src = src; else img.removeAttribute('src'); }
    img.hidden = !src;
    gen.hidden = !!st.generate?.alive;
    dot.title = v.text;
  }

  return {
    // a fresh /api/status answer
    update(next) {
      const c = next.capture || {}, g = next.generate || {};
      next.at = performance.now();
      const was = prevCap;
      prevCap = c.alive ? c.state : 'dead';
      if (was && was !== prevCap && ['camera-off', 'no-camera', 'dead'].includes(was) && ['watching', 'moving'].includes(prevCap)) connectedAt = next.now;
      // a drawing seen just now: stand it on the island at once (not old ones from before the page loaded)
      const last = c.last;
      if (Array.isArray(last?.box) && !lights.has(last.frame) && next.now - last.at < 30 && st !== null) addLight(last);
      // its thing has been built (or nothing could be made of it): the light fades
      if (['new', 'changed', 'unclear', 'failed'].includes(g.state) && g.frame) retire(g.frame);
      st = next;
      render();
    },
    // spots promised to drawings still being built, so nothing else is put there
    reserved: () => [...lights.values()].filter(l => !l.dying && !l.claimed).map(l => l.spot),
    // a new thing arrived: it takes the oldest waiting light's spot
    claimSpot() {
      const l = [...lights.values()].find(l => !l.dying && !l.claimed);
      if (!l) return null;
      l.claimed = true;
      return { x: l.spot.x, z: l.spot.z };
    },
    // …and grows out of it, while the light fades
    arrived(box) {
      for (const [f, l] of lights) if (l.claimed && !l.dying) retire(f);
      const kids = box.children.map(o => [o, o.scale.clone()]);
      for (const [o] of kids) o.scale.multiplyScalar(0.001);
      growing.push({ kids, born: performance.now() });
    },
    // every frame: the pill's seconds counter, lights pulsing and fading, new things growing
    tick(camera) {
      render();
      const now = performance.now(), t = now / 1000;
      for (const [frame, l] of lights) {
        if (now - l.born > LIGHT_MAX_S * 1000 && st?.generate?.alive) retire(frame);
        const pop = Math.min(1, (now - l.born) / 500);
        let k = 1 + Math.sin(pop * Math.PI) * 0.15 * (1 - pop) - (1 - pop) ** 3;
        if (l.dying) {
          const d = Math.min(1, (now - l.dying) / 1000);
          k *= 1 - d;
          if (d >= 1) { drop(frame); continue; }
        }
        const pulse = 1 + Math.sin(t * 3) * 0.12;
        l.g.scale.setScalar(Math.max(0.001, k));
        l.orb.scale.setScalar(pulse);
        l.halo.scale.setScalar(1.6 * pulse);
        l.light.intensity = 6 * k * pulse;
        const p = l.sparks.geometry.attributes.position;       // sparks rise and drift, then start again
        l.sparks.userData.seeds.forEach((s, i) => {
          const u = ((t + s.t0) % 1.6) / 1.6;
          p.setXYZ(i, Math.cos(s.a + u * 2) * s.r, 0.5 + u * 1.4, Math.sin(s.a + u * 2) * s.r);
        });
        p.needsUpdate = true;
        l.sparks.material.opacity = 0.9 * k;
      }
      for (let i = growing.length - 1; i >= 0; i--) {
        const gr = growing[i], u = Math.min(1, (now - gr.born) / 700);
        const k = 1 + Math.sin(u * Math.PI) * 0.18 * (1 - u) - (1 - u) ** 3;   // grows with a little bounce
        for (const [o, s] of gr.kids) o.scale.copy(s).multiplyScalar(Math.max(0.001, k));
        if (u >= 1) growing.splice(i, 1);
      }
    },
  };
}
