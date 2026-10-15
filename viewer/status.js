// What the pipeline is doing, for the person at the paper: a small pill in the corner (from
// GET /api/status, written by capture and generate) and, the moment a new drawing is seen, the
// drawing itself as a paper cut-out standing on the island where its 3D thing will appear.

const RESULT_S = 10;       // how long "✓ neu: …" / "✗ nicht erkannt" stays up
const SEEN_S = 6;          // how long "✏️ neue Zeichnung erkannt" stays up (if generate is slower to start)
const IDLE_S = 4;          // a calm pill folds to a dot after this long
const SIGN_MAX_S = 120;    // a cut-out whose thing never arrives goes away after this long

export function createStatus({ THREE, scene, el }) {
  const dot = el.querySelector('.dot'), text = el.querySelector('.text'), img = el.querySelector('img'), gen = el.querySelector('.gen');
  let st = null, lastView = '', viewSince = 0, prevCap = null, connectedAt = 0;
  const signs = new Map();           // frame → { mesh, born, dying }
  const loader = new THREE.TextureLoader();

  // where generate puts a thing for this changed_box (same mapping as generate/generate.mjs cropOf)
  function placeOf({ box: [x, y, w, h], width: W, height: H }) {
    let ix = ((x + w / 2) / W - 0.5) * 9, iz = ((y + h / 2) / H - 0.5) * 7;
    const r = Math.hypot(ix, iz);
    if (r > 5) { ix *= 5 / r; iz *= 5 / r; }
    return { x: ix, z: iz, h: Math.min(3.5, Math.max(2, (h / H) * 4.5)) };   // at least as tall as a character
  }

  function addSign(last) {
    const { x, z, h } = placeOf(last);
    loader.load(`/api/status/cutout.png?v=${encodeURIComponent(last.frame)}`, tex => {
      if (!signs.has(last.frame)) return tex.dispose();
      tex.colorSpace = THREE.SRGBColorSpace;
      const w = h * tex.image.width / tex.image.height;
      const geo = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0);
      const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.position.set(x, 0, z);
      mesh.scale.setScalar(0.001);
      scene.add(mesh);
      signs.get(last.frame).mesh = mesh;
    });
    signs.set(last.frame, { mesh: null, born: performance.now(), dying: 0 });
  }

  function retire(frame) {
    const s = signs.get(frame);
    if (s && !s.dying) s.dying = performance.now();
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
      if (last?.cutout && Array.isArray(last.box) && !signs.has(last.frame) && next.now - last.at < 30 && st !== null) addSign(last);
      // its thing has been built (or given up on): the cut-out folds away
      if (['new', 'changed', 'unclear', 'failed'].includes(g.state) && g.frame) retire(g.frame);
      if (!g.alive) for (const [f, s] of signs) if (performance.now() - s.born > 60000) retire(f);
      st = next;
      render();
    },
    // every frame: the pill's seconds counter, cut-outs popping up, facing the viewer, folding away
    tick(camera) {
      render();
      const now = performance.now();
      for (const [frame, s] of signs) {
        if (now - s.born > SIGN_MAX_S * 1000) retire(frame);
        const m = s.mesh;
        if (!m) { if (s.dying) signs.delete(frame); continue; }
        const age = (now - s.born) / 1000;
        const pop = Math.min(1, age / 0.5);
        let k = 1 + Math.sin(pop * Math.PI) * 0.15 * (1 - pop) - (1 - pop) ** 3;    // grows in with a little bounce
        if (s.dying) {
          const d = Math.min(1, (now - s.dying) / 600);
          k *= 1 - d;
          if (d >= 1) { scene.remove(m); m.geometry.dispose(); m.material.map.dispose(); m.material.dispose(); signs.delete(frame); continue; }
        }
        m.scale.setScalar(Math.max(0.001, k));
        m.rotation.y = Math.atan2(camera.position.x - m.position.x, camera.position.z - m.position.z);   // like a sign, turned to the viewer
        m.rotation.z = Math.sin(age * 1.3) * 0.03;
      }
    },
  };
}
