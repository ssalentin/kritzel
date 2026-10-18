// Shared water for drawn things: ctx.water.pond / waterfall / river. Same recipe as the island's own
// waterfall (island.js): lit standard materials with a scrolling streak texture, so the water follows
// day, night and lamps like everything else, plus foam and spray where it lands. Each call returns an
// Object3D for the thing to add to its own group; the kit animates them (tick, from world.js) and lets
// go of pieces whose thing was removed.
let causticTex = null;
// light nets: short bright arcs on black, tiled, drawn once and shared by every pond (additive blend)
function caustics(THREE) {
  if (causticTex) return causticTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  let seed = 5;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) {
    g.globalAlpha = 0.25 + r() * 0.5; g.lineWidth = 1 + r() * 2.2;
    const x = r() * 256, y = r() * 256, rad = 6 + r() * 18, a0 = r() * 6.28;
    g.beginPath(); g.arc(x, y, rad, a0, a0 + 1.2 + r() * 1.5); g.stroke();
  }
  causticTex = new THREE.CanvasTexture(cv);
  causticTex.wrapS = causticTex.wrapT = THREE.RepeatWrapping; causticTex.repeat.set(3, 3);
  causticTex.userData.shared = true;
  return causticTex;
}

export function makeWater({ THREE, scene }) {
  const TAU = Math.PI * 2;
  const live = [];                       // { obj, step(t) }
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(11);

  // streaks of light on blue: the texture every piece of water scrolls along its flow
  function streaks(base = '#5fb4e3') {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
    const g = cv.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 64, 128);
    for (let i = 0; i < 46; i++) {
      g.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.5})`;
      g.fillRect(rnd() * 64, rnd() * 128, 1 + rnd() * 3, 8 + rnd() * 36);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const waterMat = (tex, opacity = 0.88) => new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity,
    roughness: 0.12, metalness: 0.05, emissive: 0x3d8fc4, emissiveIntensity: 0.25, side: THREE.DoubleSide, depthWrite: false });
  const foamMat = () => new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, roughness: 0.4 });

  // a ribbon along points [x, y, z] with widths; uv.y runs along it so the texture flows
  function ribbon(pts, width) {
    const pos = [], uv = [], idx = [];
    let v = 0;
    pts.forEach((p, k) => {
      const q = pts[Math.min(k + 1, pts.length - 1)], o = pts[Math.max(k - 1, 0)];
      const dx = q.x - o.x, dz = q.z - o.z, l = Math.hypot(dx, dz) || 1;
      const w = (typeof width === 'function' ? width(k / (pts.length - 1)) : width) / 2;
      if (k) v += pts[k].distanceTo(pts[k - 1]);
      for (const s of [-1, 1]) { pos.push(p.x - dz / l * s * w, p.y, p.z + dx / l * s * w); uv.push((s + 1) / 2, v / 1.5); }
      if (k) { const b = (k - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // spray droplets flying up and out from a point, falling back
  function spray(at, spread, count = 16) {
    const m = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.06, 0), foamMat(), count);
    const o = new THREE.Object3D(), seeds = Array.from({ length: count }, () => [rnd() * TAU, 0.4 + rnd() * 0.6, rnd()]);
    m.frustumCulled = false;
    const step = t => {
      seeds.forEach(([a, sp, ph], i) => {
        const k = (t * 0.8 + ph) % 1;
        o.position.set(at.x + Math.cos(a) * spread * sp * k, at.y + Math.sin(k * Math.PI) * 0.35 * sp, at.z + Math.sin(a) * spread * sp * k);
        o.scale.setScalar(1 - k * 0.8);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
    };
    return { m, step };
  }

  function track(obj, step) { live.push({ obj, step }); return obj; }
  // limits, like lamps: a thing gets at most MAX pieces, sizes are clamped; world.js resets the
  // count before each thing's build and reports what was left out
  const MAX = 6;
  let used = 0, ignored = 0;
  const allow = () => (++used <= MAX) || (ignored++, false);
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : d));

  return {
    // a pond on the ground, an oval rx across x and rz across z (a circle when rz is left out): deep in the
    // middle and lighter toward the bank, a raised sandy bank round it, a calm surface that ripples slowly,
    // rings spreading out
    pond(x, z, r = 1.2, rz = r) {
      if (!allow()) return new THREE.Group();
      r = clamp(r, 0.2, 4, 1.2); rz = clamp(rz, 0.2, 4, r);
      const g = new THREE.Group(); g.position.set(x, 0, z);
      const tex = streaks('#56aee0'); tex.repeat.set(2, 2);
      // the surface: a disc whose colour and height follow the oval; the middle is the deep end
      const geo = new THREE.CircleGeometry(1, 48); geo.rotateX(-Math.PI / 2); geo.scale(r, 1, rz);
      const pos = geo.attributes.position, base = pos.array.slice(), col = [];
      const deep = new THREE.Color(0x06284f), shallow = new THREE.Color(0xa6e6fa), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const d = Math.min(1, Math.hypot(pos.getX(i) / r, pos.getZ(i) / rz));
        c.copy(deep).lerp(shallow, Math.pow(d, 1.6)); col.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const wm = waterMat(tex, 0.82); wm.vertexColors = true;
      const disc = new THREE.Mesh(geo, wm); disc.renderOrder = 2;
      // a soft caustic shimmer: light nets on the bottom, drawn over the surface and moving slowly
      const caus = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: caustics(THREE), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
      caus.renderOrder = 3; caus.position.y = 0.003;
      // the bank: a soft sand tube round the oval, so the water sits in it and the edge has height
      const bank = [];
      for (let i = 0; i < 64; i++) { const a = i / 64 * TAU; bank.push(new THREE.Vector3(Math.cos(a) * r, 0.1, Math.sin(a) * rz)); }
      const bankMesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(bank, true), 64, 0.1, 6, true),
        new THREE.MeshStandardMaterial({ color: 0xd9c48f, roughness: 0.9 }));
      const rings = [0, 1, 2].map(() => {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 4, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
        ring.rotation.x = Math.PI / 2; ring.position.y = 0.05; g.add(ring); return ring;
      });
      g.add(disc, caus, bankMesh);
      g.userData.zone = { kind: 'pond', r, rz };   // where swimmers may go (zones())
      return track(g, t => {
        tex.offset.set(Math.sin(t * 0.15) * 0.2, t * 0.04);
        caus.material.map.offset.set(t * 0.03, Math.sin(t * 0.2) * 0.1);
        for (let i = 0; i < pos.count; i++) pos.setY(i, 0.035 + 0.008 * Math.sin(t * 1.3 + base[3 * i] * 1.5 + base[3 * i + 2] * 1.5));
        pos.needsUpdate = true;
        rings.forEach((ring, i) => {
          const k = (t * 0.25 + i / 3) % 1;
          ring.scale.set(r * (0.15 + k * 0.8), rz * (0.15 + k * 0.8), 1); ring.material.opacity = 0.5 * (1 - k);
        });
      });
    },

    // water falling from `from` to `to` ([x, y, z]), `width` wide: an arc over the lip, a straight
    // drop, foam and spray where it lands
    waterfall(from, to, width = 0.6) {
      if (!allow()) return new THREE.Group();
      width = clamp(width, 0.1, 3, 0.6);
      const g = new THREE.Group();
      const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
      const out = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
      const lip = a.clone().add(out.clone().setLength(Math.min(0.3, out.length() * 0.3)));
      const curve = new THREE.CatmullRomCurve3([a, lip.clone().setY(a.y - 0.05), lip.clone().lerp(b, 0.35).setY(a.y - (a.y - b.y) * 0.4), b]);
      const tex = streaks();
      const fall = new THREE.Mesh(ribbon(curve.getPoints(24), k => width * (1 + k * 0.35)), waterMat(tex));
      fall.renderOrder = 2;
      const pool = new THREE.Mesh(new THREE.CircleGeometry(width * 0.7, 32), foamMat());
      pool.material.opacity = 0.55;
      pool.rotation.x = -Math.PI / 2; pool.position.set(b.x, b.y + 0.03, b.z);
      const s = spray(b, width * 1.2);
      g.add(fall, pool, s.m);
      return track(g, t => { tex.offset.y = -t * 1.2; s.step(t); pool.scale.setScalar(1 + Math.sin(t * 6) * 0.04); });
    },

    // a stream along the ground through points [x, z] (or [x, y, z]), `width` wide, flowing from the first point
    river(points, width = 0.7) {
      if (!allow()) return new THREE.Group();
      width = clamp(width, 0.1, 3, 0.7);
      points = (Array.isArray(points) ? points : []).slice(0, 32);
      if (!points.length) return new THREE.Group();
      const g = new THREE.Group();
      const pts = points.map(p => new THREE.Vector3(p[0], p.length > 2 ? p[1] : 0.04, p.length > 2 ? p[2] : p[1]));
      const curve = new THREE.CatmullRomCurve3(pts.length > 1 ? pts : [pts[0], pts[0].clone().add(new THREE.Vector3(1, 0, 0))]);
      const tex = streaks();
      const water = new THREE.Mesh(ribbon(curve.getPoints(Math.max(16, pts.length * 10)), width), waterMat(tex, 0.85));
      water.renderOrder = 2;
      const banks = [-1, 1].map(side => {
        const edge = curve.getPoints(Math.max(16, pts.length * 10)).map((p, k, all) => {
          const q = all[Math.min(k + 1, all.length - 1)], o = all[Math.max(k - 1, 0)];
          const n = new THREE.Vector3(-(q.z - o.z), 0, q.x - o.x).normalize().multiplyScalar(side * width / 2);
          return p.clone().add(n).setY(p.y + 0.01);
        });
        return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), edge.length, 0.04, 5), foamMat());
      });
      g.add(water, ...banks);
      g.userData.zone = { kind: 'river', points: curve.getPoints(24), width };
      return track(g, t => { tex.offset.y = -t * 0.6; });
    },

    begin() { used = ignored = 0; },
    // the water on the island now, in world coordinates, for creatures that swim:
    // { kind: 'pond', x, z, r, rz } (an oval: r across x, rz across z) or { kind: 'river', points: [{ x, z }], width }
    zones() {
      const out = [], v = new THREE.Vector3();
      for (const { obj } of live) {
        const z = obj.userData.zone;
        let o = obj; while (o.parent) o = o.parent;
        if (!z || o !== scene) continue;
        obj.updateMatrixWorld(true);
        if (z.kind === 'pond') { obj.getWorldPosition(v); out.push({ kind: 'pond', x: v.x, z: v.z, r: z.r, rz: z.rz }); }
        else {                             // only stretches on the ground (a river can also run down a rock face)
          const pts = z.points.map(p => obj.localToWorld(v.copy(p)).clone()).filter(p => p.y < 0.3).map(p => ({ x: p.x, z: p.z }));
          if (pts.length) out.push({ kind: 'river', width: z.width, points: pts });
        }
      }
      return out;
    },
    ignored: () => ignored,
    tick(t) {
      for (let i = live.length - 1; i >= 0; i--) {
        let o = live[i].obj;
        while (o.parent) o = o.parent;
        if (o !== scene) { live.splice(i, 1); continue; }   // its thing was removed
        live[i].step(t);
      }
    },
  };
}
