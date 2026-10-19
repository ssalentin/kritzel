// A white gloved hand at the pointer. Unlit white with a dark backing shell, so it stays white
// at dusk and night and reads on cream paper. The glove silhouette has three long fingers, a
// cuff, and separate index and thumb fingers; the index tip is the rig origin. At rest the thumb
// forms a V with the index; while carrying it closes on the index tip and the other fingers curl.
// The palm sits right of the pointer so it does not cover the figure it points at.
export function createHand(THREE) {
  const glove = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const cuffMat = new THREE.MeshBasicMaterial({ color: 0xf3e7cc });
  const ink = new THREE.LineBasicMaterial({ color: 0x211d19 });
  const root = new THREE.Group(), rig = new THREE.Group();
  root.add(rig);
  root.scale.setScalar(1.6);

  function rounded(x0, y0, x1, y1, r) {
    const s = new THREE.Shape(), rr = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
    s.moveTo(x0 + rr, y0);
    s.lineTo(x1 - rr, y0); s.quadraticCurveTo(x1, y0, x1, y0 + rr);
    s.lineTo(x1, y1 - rr); s.quadraticCurveTo(x1, y1, x1 - rr, y1);
    s.lineTo(x0 + rr, y1); s.quadraticCurveTo(x0, y1, x0, y1 - rr);
    s.lineTo(x0, y0 + rr); s.quadraticCurveTo(x0, y0, x0 + rr, y0);
    return s;
  }
  function piece(shape, parent = rig, mat = glove, depth = 0.16) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: false, curveSegments: 5,
    });
    geo.translate(0, 0, -depth / 2);
    const m = new THREE.Mesh(geo, mat);
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 18), ink));
    parent.add(m);
    return m;
  }

  // one glove silhouette: palm with three long, separated fingers (notches between them)
  const palmShape = new THREE.Shape();
  palmShape.moveTo(0.15, 0.95); palmShape.lineTo(0.95, 0.95); palmShape.lineTo(0.95, 0.55);
  palmShape.lineTo(0.76, 0.55); palmShape.lineTo(0.76, 0.0); palmShape.lineTo(0.64, 0.0); palmShape.lineTo(0.64, 0.55);
  palmShape.lineTo(0.54, 0.55); palmShape.lineTo(0.54, 0.0); palmShape.lineTo(0.42, 0.0); palmShape.lineTo(0.42, 0.55);
  palmShape.lineTo(0.32, 0.55); palmShape.lineTo(0.32, 0.0); palmShape.lineTo(0.2, 0.0); palmShape.lineTo(0.2, 0.55);
  palmShape.lineTo(0.15, 0.55); palmShape.lineTo(0.15, 0.95);
  piece(palmShape);
  // cuff band, slightly wider than the palm
  piece(rounded(0.1, 0.93, 0.98, 1.2, 0.08), rig, cuffMat, 0.2);

  // index: a long finger from the palm's right side down to the pointer (the rig origin)
  const index = new THREE.Group(); index.position.set(0.87, 0.55, 0.04); rig.add(index);
  const indexMesh = piece(rounded(-0.08, -1.03, 0.08, 0.06, 0.07), index, glove, 0.14);
  indexMesh.rotation.z = -0.99;
  // thumb: leaves the left side of the palm; at rest its tip is away from the index
  const thumb = new THREE.Group(); thumb.position.set(0.17, 0.55, 0.05); rig.add(thumb);
  const thumbMesh = piece(rounded(-0.075, -0.5, 0.075, 0.06, 0.065), thumb, glove, 0.14);
  thumbMesh.rotation.z = 0.9;

  let pinch = 0, pose = 'idle', openedAt = -9, prevCarry = false;
  const api = {
    group: root,
    get pinch() { return pinch; },
    get pose() { return pose; },
    update(dt, t, { carrying = false, pressing = false, moving = false } = {}) {
      if (prevCarry && !carrying) openedAt = t;
      prevCarry = carrying;
      const target = carrying ? 1 : 0;
      pinch += (target - pinch) * (1 - Math.exp(-dt / (carrying ? 0.06 : 0.075)));
      const bump = Math.max(0, Math.sin(Math.min(1, (t - openedAt) / 0.17) * Math.PI)) * 0.12;
      pose = carrying ? 'pinch' : pressing ? 'press' : t - openedAt < 0.2 ? 'open' : 'idle';
      const press = pressing ? 1 : 0;
      thumb.rotation.z = -1.15 * pinch - bump * 0.5;          // the thumb crosses to the index tip
      index.rotation.z = 0.04 * pinch;
      index.scale.y = 1 - 0.06 * pinch;
      rig.rotation.x = 0.04 + 0.05 * pinch + 0.04 * press;
      rig.rotation.z = -0.05 + 0.04 * pinch + (moving ? Math.sin(t * 1.7) * 0.02 : 0);
      rig.position.y = 0.02 * pinch + (moving ? Math.sin(t * 1.3) * 0.008 : 0);
    },
  };
  return api;
}
