// What the pipeline is doing, for the person at the paper: a small pill in the corner (from
// GET /api/status, written by capture and generate) and, the moment a new drawing is seen, a
// warm glowing light on the free spot of the island where its 3D thing will grow out of it.
import { t, lang } from './i18n.js';

const RESULT_S = 10;       // how long "✓ neu: …" / "✗ nicht erkannt" stays up
const SEEN_S = 6;          // how long "✏️ neue Zeichnung erkannt" stays up (if generate is slower to start)
const KIND_S = 2;          // a labelled change says what it is before the build message takes over
const IDLE_S = 4;          // a calm pill folds to a dot after this long
const LIGHT_MAX_S = 120;   // a light whose thing never arrives (generator running) goes away after this long
const LIGHT_MAX = 3;       // waiting lights at once; with the generator down, the oldest goes when a new drawing comes

// The pill's text for a moment, from both stages' status files — pure, so it can be tested without a DOM.
export function pillView({ st, now, seenAt = 0, connectedAt = 0 }) {
  const c = st?.capture || {}, g = st?.generate || {}, last = c.last;
  // a name from generate: { de, en } or a plain (German) string
  const say = x => typeof x === 'string' ? x : x?.[lang()] || x?.de || '';
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  // a change Jev has just labelled: say what it is before generate's build message takes over
  if (last?.kind && last.kind !== 'unchanged' && now - last.at < KIND_S)
    return { tone: 'busy', text: t('seenKind', t('kind_' + last.kind)) };
  if (g.alive && g.state === 'building') {
    if (g.now) return { tone: 'busy', text: t('buildingNow', say(g.now)) };
    const seen = (g.seen || []).map(say).filter(Boolean);
    if (seen.length && now - seenAt < 4) return { tone: 'busy', text: t('seenList', cap(seen.slice(0, 4).join(', '))) };
    if (seen.length) return { tone: 'busy', text: t('coming', seen[0]) };
    return { tone: 'busy', text: t('thinking', Math.max(0, Math.round(now - g.since))) };
  }
  if (g.alive && now - g.since < RESULT_S) {
    if (g.state === 'new' || g.state === 'changed') {
      if (g.detail === 'removed') return { tone: 'ok', text: t('changed', t('removed')) };
      const names = (g.made?.length ? g.made.map(say) : (g.detail || '').split(', ')).filter(Boolean);
      return { tone: 'ok', text: '✓ ' + (names.length ? names.slice(0, 3).map(n => t('hello', n)).join(' ') : t('made', '')) };
    }
    if (g.state === 'unclear') return { tone: 'warn', text: g.why ? '🤷 ' + say(g.why) : t('notKnown') };
    if (g.state === 'failed') return { tone: 'warn', text: t('failedSoft') };
    if (g.state === 'idle' && last && g.frame === last.frame) return { tone: 'ok', text: t('nothingNew') };
  }
  if (last && now - last.at < SEEN_S) {
    // without a label from Jev: something is happening, we don't know what yet
    return { tone: 'busy', text: t('noticed') };
  }
  if (!c.alive) return { tone: 'bad', text: t('captureOff') };
  if (c.state === 'camera-off') return { tone: 'bad', text: t('cameraOff') };
  if (c.state === 'no-camera') return { tone: 'bad', text: t('noCamera') };
  if (c.state === 'no-paper') return { tone: 'warn', text: t('noPaper') };
  if (c.state === 'moving') return { tone: 'ok', text: c.detail === 'hand on the paper' ? t('handOnPaper') : t('moving') };
  if (now - connectedAt < 3) return { tone: 'ok', text: t('connected') };
  return { tone: 'ok', text: t('watching'), calm: true };
}

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

export function createStatus({ THREE, scene, el, world, banner, onView = null }) {
  const dot = el.querySelector('.dot'), text = el.querySelector('.text'), gen = el.querySelector('.gen');
  let st = null, lastView = '', viewSince = 0, prevCap = null, connectedAt = 0;
  const lights = new Map();          // frame → { g, light, orb, halo, sparks, spot, born, dying, claimed }
  const glow = glowTexture(THREE);
  let modeNote = '', modeNoteUntil = 0, seenFor = null, seenAt = 0;   // when the names for this frame first came
  const growing = [];                // things that just arrived, folding up out of the page
  const bursts = [];                 // paper confetti flying out of them
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);   // reused every frame
  let lastTick = performance.now();

  // a burst of little paper snippets in pastel colours, flying up and fluttering down
  function confetti(x, y, z) {
    const n = 70, cols = [0xff8fa3, 0xffd36e, 0x8fd6ff, 0xa6e3a1, 0xc9a7ff, 0xffffff];
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.13, 0.09), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true }), n);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 2.5;
      parts.push({ p: new THREE.Vector3(x, y, z), v: new THREE.Vector3(Math.cos(a) * s * 0.6, 3 + Math.random() * 3.5, Math.sin(a) * s * 0.6),
        r: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0), spin: (Math.random() - 0.5) * 14 });
      mesh.setColorAt(i, new THREE.Color(cols[i % cols.length]));
    }
    scene.add(mesh);
    bursts.push({ mesh, parts, born: performance.now() });
  }

  // where generate puts a thing for this changed_box (same mapping as generate/generate.mjs cropOf),
  // and roughly how much room it will need
  function placeOf({ box: [x, y, w, h], width: W, height: H }) {
    // the whole frame onto the whole pages (as world.js fromPaper does)
    const ix = Math.max(-8.3, Math.min(8.3, ((x + w / 2) / W - 0.5) * 16.6)), iz = Math.max(-6, Math.min(6, ((y + h / 2) / H - 0.5) * 12));
    return { x: ix, z: iz, r: Math.min(1.8, Math.max(0.6, (Math.max(w / W, h / H)) * 4.5 * 0.4)) };
  }

  function addLight(last) {
    const want = placeOf(last);
    // every light is a PointLight; a stopped generator must not let them pile up (each one recompiles all materials)
    const waiting = [...lights].filter(([, l]) => !l.dying);
    for (const [f] of waiting.slice(0, Math.max(0, waiting.length - (LIGHT_MAX - 1)))) retire(f);
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

  function retire(frame, fast = false) {
    const l = lights.get(frame);
    if (l && !l.dying) { l.dying = performance.now(); l.fadeMs = fast ? 250 : 1000; }
  }


  function drop(frame) {
    const l = lights.get(frame);
    scene.remove(l.g);
    l.orb.geometry.dispose(); l.orb.material.dispose(); l.halo.material.dispose(); l.sparks.geometry.dispose(); l.sparks.material.dispose();
    lights.delete(frame);
  }

  // the pill narrates in a kids' voice (issue #18): what Kritzel notices, sees, builds and greets
  function view(now) {
    if (performance.now() < modeNoteUntil) return { tone: 'ok', text: modeNote };   // the mode just changed
    return pillView({ st, now, seenAt, connectedAt });
  }

  function render() {
    if (!st) return;
    const now = st.now + (performance.now() - st.at) / 1000;   // server clock, ticking between polls
    const v = view(now);
    onView?.(v, st);                              // the picture frame (camframe.js) says the same thing
    const key = v.text.replace(/\d+ s$/, '');
    if (key !== lastView) { lastView = key; viewSince = performance.now(); }
    el.dataset.tone = v.tone;
    el.classList.toggle('calm', !!v.calm && performance.now() - viewSince > IDLE_S * 1000);
    if (text.textContent !== v.text) text.textContent = v.text;
    gen.hidden = !!st.generate?.alive;
    if (gen.textContent !== t('generatorOff')) gen.textContent = t('generatorOff');
    dot.title = v.text;
  }

  return {
    // a fresh /api/status answer
    update(next) {
      const ng = next.generate || {};
      if (ng.seen?.length && seenFor !== ng.frame) { seenFor = ng.frame; seenAt = next.now; }
      if (next.mode && st?.mode && next.mode !== st.mode) {           // shown briefly in the pill (issue #16)
        modeNote = next.mode === 'switch' ? t('modeNoteSwitch') : t('modeNoteAdd'); modeNoteUntil = performance.now() + 4000;
      }
      const c = next.capture || {}, g = next.generate || {};
      next.at = performance.now();
      const was = prevCap;
      prevCap = c.alive ? c.state : 'dead';
      if (was && was !== prevCap && ['camera-off', 'no-camera', 'dead'].includes(was) && ['watching', 'moving'].includes(prevCap)) connectedAt = next.now;
      // a drawing seen just now: its light comes once generate has recognised something in it (Sebastian,
      // 2026-10-17: no light for a shadow or a nudged sheet), not when capture merely noticed a change
      const last = c.last, named = ng.frame === last?.frame && ng.seen?.length > 0;
      if (Array.isArray(last?.box) && named && !lights.has(last.frame) && next.now - last.at < 30 && st !== null) addLight(last);
      // its thing has been built (or nothing could be made of it): the light fades
      if (['new', 'changed', 'failed'].includes(g.state) && g.frame) retire(g.frame);
      // nothing new after all (a nudged sheet, a shadow): generate says so (triage 'none' → idle, or
      // unclear) and the light goes out at once instead of glowing on for a thing that never comes
      if (g.frame && (g.state === 'idle' || g.state === 'unclear' || g.triage?.kind === 'none')) retire(g.frame, true);
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
    arrived(box, name, foot) {
      for (const [f, l] of lights) if (l.claimed && !l.dying) retire(f);
      const b = new THREE.Box3().setFromObject(box);
      if (!b.isEmpty()) confetti(foot?.x ?? (b.min.x + b.max.x) / 2, Math.min(b.max.y, 3), foot?.z ?? (b.min.z + b.max.z) / 2);
      if (banner && name) { banner.textContent = `${name.length > 24 ? name.slice(0, 23) + '…' : name}!`; banner.classList.remove('on'); void banner.offsetWidth; banner.classList.add('on'); }
      // pop-up: each piece lies flat on the page and folds up, hinged at its base (its own origin)
      const kids = box.children.map(o => [o, o.rotation.x]);
      for (const [o, rx] of kids) o.rotation.x = rx - Math.PI / 2;
      growing.push({ kids, born: performance.now() });
    },
    // every frame: the pill's seconds counter, lights pulsing and fading, new things growing
    tick(camera) {
      render();
      const now = performance.now(), t = now / 1000, dt = Math.min(0.05, (now - lastTick) / 1000);
      lastTick = now;
      for (let i = bursts.length - 1; i >= 0; i--) {
        const bu = bursts[i], age = (now - bu.born) / 1000;
        bu.parts.forEach((pa, j) => {
          pa.v.y -= 7 * dt; pa.v.multiplyScalar(pa.v.y < 0 ? 1 - 2.5 * dt : 1);   // paper: falls slowly, flutters
          pa.p.addScaledVector(pa.v, dt);
          if (pa.p.y < 0.03) { pa.p.y = 0.03; pa.v.set(0, 0, 0); }
          pa.r.x += pa.spin * dt; pa.r.y += pa.spin * 0.7 * dt;
          bu.mesh.setMatrixAt(j, m4.compose(pa.p, q.setFromEuler(pa.r), one));
        });
        bu.mesh.instanceMatrix.needsUpdate = true;
        bu.mesh.material.opacity = Math.min(1, (3.2 - age) / 0.8);
        if (age > 3.2) { scene.remove(bu.mesh); bu.mesh.geometry.dispose(); bu.mesh.material.dispose(); bu.mesh.dispose(); bursts.splice(i, 1); }
      }
      for (const [frame, l] of lights) {
        if (now - l.born > LIGHT_MAX_S * 1000 && st?.generate?.alive) retire(frame);
        const pop = Math.min(1, (now - l.born) / 500);
        let k = 1 + Math.sin(pop * Math.PI) * 0.15 * (1 - pop) - (1 - pop) ** 3;
        if (l.dying) {
          const d = Math.min(1, (now - l.dying) / (l.fadeMs || 1000));
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
        const gr = growing[i], u = Math.min(1, (now - gr.born) / 800);
        const k = 1 + Math.sin(u * Math.PI) * 0.12 * (1 - u) - (1 - u) ** 3;   // folds up, a little past upright and back
        for (const [o, rx] of gr.kids) o.rotation.x = rx - (1 - k) * Math.PI / 2;
        if (u >= 1) growing.splice(i, 1);
      }
    },
  };
}
