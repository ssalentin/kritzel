// The floating island itself (grass top, layered soil, rocky underside, roots,
// a waterfall pouring off the edge from the pond) and the sky (sun, clouds).
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// waterfall / sky are optional: a world only shows what was drawn
export function buildIsland({ THREE, world, mat, rand, pond, camera, waterfall = true, sky = true }) {
  const TAU = Math.PI * 2, N = 80;
  const col = new THREE.Color();

  // irregular outline of the grass top (always > 7.5, the walkable area ends at 6.9)
  const edge = [];
  for (let i = 0; i < N; i++) {
    const a = i / N * TAU;
    edge.push(8 + 0.22 * Math.sin(3 * a + 1) + 0.16 * Math.sin(7 * a + 2) + 0.07 * Math.sin(13 * a));
  }
  const edgeR = a => {
    const f = (((a / TAU) % 1) + 1) % 1 * N, i = Math.floor(f), k = f - i;
    return edge[i % N] * (1 - k) + edge[(i + 1) % N] * k;
  };
  const patch = (x, z) => Math.sin(x * 0.9 + z * 0.4) * 0.5 + Math.sin(x * 0.3 - z * 1.1 + 1.7) * 0.3 + Math.sin(x * 2.1 + z * 1.7) * 0.2;

  // ---------- grass top: soft colour patches through vertex colours ----------
  {
    const ringsF = [0, 0.2, 0.4, 0.58, 0.72, 0.84, 0.93, 1];
    const pos = [], cols = [], idx = [];
    const gA = new THREE.Color(0x93bd72), gB = new THREE.Color(0x76a35e), gC = new THREE.Color(0xaccb8a);
    const tint = (x, z, edgeK) => {
      const n = patch(x, z);
      col.copy(gA).lerp(n > 0 ? gC : gB, Math.min(1, Math.abs(n) * 1.3));
      col.lerp(gB, edgeK * 0.35);
      cols.push(col.r, col.g, col.b);
    };
    pos.push(0, 0, 0); tint(0, 0, 0);
    for (let j = 1; j < ringsF.length; j++)
      for (let i = 0; i < N; i++) {
        const a = i / N * TAU, r = edge[i] * ringsF[j];
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        pos.push(x, 0, z); tint(x, z, ringsF[j] > 0.9 ? 1 : 0);
      }
    const at = (j, i) => j === 0 ? 0 : 1 + (j - 1) * N + (i % N);
    for (let j = 1; j < ringsF.length; j++)
      for (let i = 0; i < N; i++) {
        if (j === 1) { idx.push(0, at(1, i + 1), at(1, i)); continue; }
        idx.push(at(j - 1, i), at(j, i + 1), at(j, i), at(j - 1, i), at(j - 1, i + 1), at(j, i + 1));
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const top = new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true, roughness: 0.95, flatShading: false }));
    top.receiveShadow = true;
    world.add(top);
  }

  // ---------- sides: grass lip, soil strata, then craggy rock down to a point ----------
  {
    const rows = [
      { y: 0, k: 1, c: 0x7fa866, j: 0 },
      { y: -0.24, k: 1.012, c: 0x618a4d, j: 0 },
      { y: -0.34, k: 0.99, c: 0x7a4c30, j: 0.02 },
      { y: -0.82, k: 0.982, c: 0xc29466, j: 0.03 },
      { y: -0.96, k: 0.975, c: 0x9c6a43, j: 0.04 },
      { y: -1.42, k: 0.958, c: 0x86593a, j: 0.05 },
      { y: -1.58, k: 0.93, c: 0xb8aea2, j: 0.1 },
      { y: -2.3, k: 0.87, c: 0xa89d92, j: 0.28 },
      { y: -3.1, k: 0.76, c: 0xbcb0a2, j: 0.32 },
      { y: -3.9, k: 0.63, c: 0x9d948d, j: 0.34 },
      { y: -4.8, k: 0.48, c: 0xb0a497, j: 0.3 },
      { y: -5.7, k: 0.33, c: 0x9a918b, j: 0.26 },
      { y: -6.6, k: 0.18, c: 0xaea397, j: 0.18 },
      { y: -7.3, k: 0.06, c: 0x938a86, j: 0.08 },
      { y: -7.6, k: 0, c: 0x938a86, j: 0 },
    ];
    const grid = rows.map(row => edge.map((e, i) => {
      const a = i / N * TAU + (rand() - 0.5) * row.j * 0.05;
      const r = Math.max(0, e * row.k + (rand() - 0.5) * row.j * 2);
      return [Math.cos(a) * r, row.y + (rand() - 0.5) * row.j * 0.9, Math.sin(a) * r];
    }));
    const pos = [], cols = [];
    const tri = (p, q, s, c) => { pos.push(...p, ...q, ...s); for (let k = 0; k < 3; k++) cols.push(c.r, c.g, c.b); };
    for (let j = 0; j < rows.length - 1; j++) {
      const base = new THREE.Color(rows[j].c), varAmt = rows[j].j > 0.08 ? 0.12 : 0.04;
      for (let i = 0; i < N; i++) {
        const U0 = grid[j][i], U1 = grid[j][(i + 1) % N], L0 = grid[j + 1][i], L1 = grid[j + 1][(i + 1) % N];
        tri(U0, U1, L0, col.copy(base).multiplyScalar(1 + (rand() - 0.5) * varAmt));
        tri(U1, L1, L0, col.copy(base).multiplyScalar(1 + (rand() - 0.5) * varAmt));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    const side = new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true, roughness: 0.9 }));
    side.castShadow = true; side.receiveShadow = true;
    world.add(side);
  }

  // ---------- dangling roots and vines ----------
  const fallA = Math.atan2(pond.z, pond.x);
  const strands = (count, y0, y1, len, r, color) => {
    const geos = [];
    for (let i = 0; i < count; i++) {
      let a;
      do a = rand() * TAU; while (Math.abs(Math.atan2(Math.sin(a - fallA), Math.cos(a - fallA))) < 0.2);
      const r0 = edgeR(a) * 0.985 - 0.04, y = y0 + rand() * (y1 - y0), l = len * (0.5 + rand());
      const pts = [[r0, y], [r0 + 0.12, y - l * 0.3], [r0 + 0.04, y - l * 0.65], [r0 + 0.1 + rand() * 0.1, y - l]]
        .map(([rr, yy], k) => new THREE.Vector3(Math.cos(a + k * 0.02) * rr, yy, Math.sin(a + k * 0.02) * rr));
      geos.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, r * (0.7 + rand() * 0.6), 4));
    }
    const m = new THREE.Mesh(mergeGeometries(geos), mat(color, { roughness: 0.9 }));
    m.castShadow = true;
    world.add(m);
  };
  strands(14, -0.5, -1.3, 1.0, 0.03, 0x6b4630);
  strands(14, -0.12, -0.2, 0.7, 0.025, 0x4f9a3c);

  // ---------- waterfall: stream from the pond over the edge ----------
  const water = {};
  if (waterfall) {
    const pd = Math.hypot(pond.x, pond.z), e = edgeR(fallA);
    const path = [[pd + pond.r - 0.4, 0.035, 0.5], [e, 0.035, 0.55], [e + 0.16, -0.06, 0.58], [e + 0.3, -0.35, 0.6],
      [e + 0.42, -1.1, 0.65], [e + 0.5, -2.4, 0.72], [e + 0.52, -3.8, 0.8], [e + 0.5, -5.2, 0.88]];
    const dx = Math.cos(fallA), dz = Math.sin(fallA), px = -dz, pz = dx;
    const pos = [], uv = [], cols = [], idx = [];
    let v = 0;
    path.forEach(([r, y, w], k) => {
      if (k) v += Math.hypot(r - path[k - 1][0], y - path[k - 1][1]);
      const alpha = y > -2.6 ? 0.92 : Math.max(0, 0.92 - (-2.6 - y) / 2.8);
      for (const s of [-1, 1]) {
        pos.push(dx * r + px * s * w / 2, y, dz * r + pz * s * w / 2);
        uv.push((s + 1) / 2, v / 1.6);
        cols.push(1, 1, 1, alpha);
      }
      if (k) { const b = (k - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
    const g2 = cv.getContext('2d');
    g2.fillStyle = '#62b9e6'; g2.fillRect(0, 0, 64, 128);
    for (let i = 0; i < 46; i++) {
      g2.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.5})`;
      g2.fillRect(rand() * 64, rand() * 128, 1 + rand() * 3, 10 + rand() * 40);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    water.tex = tex;
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, transparent: true,
      roughness: 0.15, emissive: 0x5aaee0, emissiveIntensity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
    m.renderOrder = 2;
    world.add(m);
    // a few spray droplets where the water tips over the edge
    const sprayGeo = new THREE.IcosahedronGeometry(0.07, 0);
    water.spray = new THREE.InstancedMesh(sprayGeo, mat(0xffffff, { transparent: true, opacity: 0.8, roughness: 0.3 }), 14);
    water.spray.userData = { base: [dx * (e + 0.25), dz * (e + 0.25)], px, pz };
    world.add(water.spray);
  }

  // ---------- little floating rocks drifting around the island ----------
  const floaters = [];
  for (let i = 0; i < 6; i++) {
    const f = new THREE.Group(), s = 0.35 + rand() * 0.45;
    const rk = new THREE.Mesh(new THREE.ConeGeometry(s, s * 1.8, 6), mat(0x8f8984, { roughness: 0.9 }));
    rk.rotation.x = Math.PI; rk.position.y = -s * 0.9;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(s * 1.04, s, s * 0.22, 6), mat(0x86ad6c));
    f.add(rk, cap);
    const a = i / 6 * TAU + rand() * 0.6, d = 9.3 + rand() * 1.0;
    f.position.set(Math.cos(a) * d, -1.4 - rand() * 2.0, Math.sin(a) * d);
    f.rotation.y = rand() * TAU;
    f.traverse(o => { if (o.isMesh) o.castShadow = true; });
    world.add(f);
    floaters.push({ f, y: f.position.y, ph: rand() * TAU });
  }

  // ---------- sky: puffy clouds and the drawn sun ----------
  const cloudMat = mat(0xffffff, { roughness: 1, emissive: 0xc9d6dc, emissiveIntensity: 0.45 });
  const makeCloud = (puffs, size) => {
    const geos = [];
    for (let k = 0; k < puffs; k++) {
      const s = size * (0.85 + rand() * 0.5) * (k === 0 || k === puffs - 1 ? 0.75 : 1);
      geos.push(new THREE.IcosahedronGeometry(s, 1).translate((k - (puffs - 1) / 2) * size * 1.05, Math.sin(k * 1.7) * size * 0.2, (rand() - 0.5) * size * 0.5));
      if (k > 0 && k < puffs - 1) geos.push(new THREE.IcosahedronGeometry(s * 0.8, 1).translate((k - (puffs - 1) / 2) * size * 1.05, size * 0.6, 0));
    }
    const geo = mergeGeometries(geos);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, Math.max(p.getY(i), -size * 0.45));
    geo.computeVertexNormals();
    const c = new THREE.Mesh(geo, cloudMat);
    c.castShadow = true;
    return c;
  };
  const clouds = [];
  for (let i = 0; i < 4; i++) {
    const c = makeCloud(3 + (i % 2), 0.45);
    c.position.set(-10 + i * 5.5, 5.2 + rand() * 1.2, -6 + rand() * 4);
    if (sky) world.add(c);
    clouds.push(c);
  }
  const bigCloud = makeCloud(5, 0.6);

  const sunGroup = new THREE.Group();
  const sunBasic = c => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(0.9, 32), sunBasic(0xffcc33));
  const sunCore = new THREE.Mesh(new THREE.CircleGeometry(0.68, 32), sunBasic(0xffe27a));
  sunCore.position.z = 0.01;
  const hcv = document.createElement('canvas'); hcv.width = hcv.height = 128;
  const hg = hcv.getContext('2d'), grad = hg.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,236,150,0.9)'); grad.addColorStop(0.35, 'rgba(255,226,120,0.35)'); grad.addColorStop(1, 'rgba(255,226,120,0)');
  hg.fillStyle = grad; hg.fillRect(0, 0, 128, 128);
  const htex = new THREE.CanvasTexture(hcv); htex.colorSpace = THREE.SRGBColorSpace;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: htex, transparent: true, depthWrite: false, toneMapped: false }));
  glow.scale.setScalar(5);
  glow.position.z = -0.05;
  const rays = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const long = i % 2 === 0;
    const ray = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, long ? 0.55 : 0.32, 2, 6), sunBasic(0xffbf1f));
    const a = (i / 12) * TAU, rr = long ? 1.42 : 1.3;
    ray.position.set(Math.cos(a) * rr, Math.sin(a) * rr, 0);
    ray.rotation.z = a - Math.PI / 2;
    rays.add(ray);
  }
  sunGroup.add(glow, sunDisc, sunCore, rays);

  return {
    edgeR, clouds, bigCloud, sunGroup, rays, glow,
    update(t) {
      if (water.tex) {
        water.tex.offset.y = -t * 0.9;
        const { base, px, pz } = water.spray.userData, o = new THREE.Object3D();
        for (let i = 0; i < 14; i++) {
          const k = (t * 0.7 + i / 14) % 1, s = (i % 7 - 3) / 7;
          o.position.set(base[0] + px * s * 0.6 + Math.cos(fallA) * k * 0.5, -0.1 + Math.sin(k * Math.PI) * 0.25 - k * k * 0.9, base[1] + pz * s * 0.6 + Math.sin(fallA) * k * 0.5);
          o.scale.setScalar(1 - k);
          o.updateMatrix();
          water.spray.setMatrixAt(i, o.matrix);
        }
        water.spray.instanceMatrix.needsUpdate = true;
      }
      for (const fl of floaters) { fl.f.position.y = fl.y + Math.sin(t * 0.6 + fl.ph) * 0.25; fl.f.rotation.y += 0.001; }
      sunGroup.quaternion.copy(camera.quaternion);
    },
  };
}
