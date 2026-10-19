// A small white-gloved hand for the page. It is a 3D rig of extruded, rounded shapes that faces
// the camera, with the index fingertip at the group's origin so placing the group at the pointer's
// page point puts the fingertip there. The index and thumb are separate groups: a press lowers the
// fingers, a pinch closes thumb and index over ~120 ms while carrying, and releasing opens with a
// small overshoot.
export function createHand(THREE) {
  const glove = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, flatShading: true,
    emissive: 0xffffff, emissiveIntensity: 0.08 });
  const cuffMat = new THREE.MeshStandardMaterial({ color: 0xf1ecdf, roughness: 0.72, metalness: 0, flatShading: true });
  const ink = new THREE.LineBasicMaterial({ color: 0x2f2a24, transparent: true, opacity: 0.72 });
  const root = new THREE.Group(), rig = new THREE.Group();
  root.add(rig);
  root.scale.setScalar(1.25);

  function rounded(x0, y0, x1, y1, r) {
    const s = new THREE.Shape(), w = x1 - x0, h = y1 - y0, rr = Math.min(r, w / 2, h / 2);
    s.moveTo(x0 + rr, y0);
    s.lineTo(x1 - rr, y0); s.quadraticCurveTo(x1, y0, x1, y0 + rr);
    s.lineTo(x1, y1 - rr); s.quadraticCurveTo(x1, y1, x1 - rr, y1);
    s.lineTo(x0 + rr, y1); s.quadraticCurveTo(x0, y1, x0, y1 - rr);
    s.lineTo(x0, y0 + rr); s.quadraticCurveTo(x0, y0, x0 + rr, y0);
    return s;
  }
  function piece(shape, parent = rig, mat = glove, depth = 0.18) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 2, curveSegments: 6,
    });
    geo.translate(0, 0, -depth / 2);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), ink));
    parent.add(m);
    return m;
  }

  // cuff and wrist, behind the glove back
  piece(rounded(-0.46, 1.12, 0.46, 1.7, 0.12), rig, cuffMat, 0.2);
  piece(rounded(-0.38, 0.98, 0.38, 1.2, 0.1), rig, glove, 0.2);
  // a broad palm; the fingers come out of its lower edge
  piece(rounded(-0.64, 0.42, 0.64, 1.08, 0.2));
  // three relaxed fingers (middle, ring, little)
  piece(rounded(-0.32, 0.02, -0.06, 0.54, 0.11));
  piece(rounded(-0.54, 0.14, -0.29, 0.54, 0.1));
  piece(rounded(-0.74, 0.26, -0.51, 0.54, 0.09));

  // index: pivot at the knuckle, the tip rests at the rig origin (0, 0)
  const index = new THREE.Group(); index.position.set(0, 0.55, 0.02); rig.add(index);
  piece(rounded(-0.115, -0.55, 0.115, 0.12, 0.1), index, glove, 0.16);
  // thumb: angled down-left from the side of the palm
  const thumb = new THREE.Group(); thumb.position.set(0.52, 0.48, 0.02); rig.add(thumb);
  const thumbMesh = piece(rounded(-0.1, -0.48, 0.1, 0.1, 0.09), thumb, glove, 0.16);
  thumbMesh.rotation.z = -0.62;

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
      index.position.x = 0.18 * pinch;                           // the two fingertips meet at the pinch
      index.rotation.z = 0.08 * pinch + bump * 0.5;
      thumb.position.x = 0.52 - 0.28 * pinch;
      thumb.rotation.z = 0.62 * pinch - bump * 0.4;
      thumb.rotation.x = 0.08 * pinch;
      rig.rotation.x = 0.04 + 0.04 * pinch + 0.04 * press;
      rig.rotation.z = -0.04 + 0.03 * pinch + (moving ? Math.sin(t * 1.7) * 0.018 : 0);
      rig.position.y = 0.02 * pinch + (moving ? Math.sin(t * 1.3) * 0.008 : 0);
    },
  };
  return api;
}
