// What a figure can pick up and carry, decided in one place: the viewer (world.js) makes a thing portable by it,
// and generate's quest writer offers only such things for a 'bring' quest (GitHub #25). Pure, no three.js import:
// footprintOf gets THREE from its caller, so it runs in the browser and in node alike.

// the ground footprint of a thing's group, vertex-exact: { x, z, hx, hz, r, top }, or null for a flat or floating
// thing, or one that covers too much of the pages (more than maxArea)
export function footprintOf(box, THREE, maxArea) {
  const b = new THREE.Box3(), m = new THREE.Box3();
  box.updateMatrixWorld(true);
  box.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    m.setFromObject(o, true);                              // vertex-exact
    if (m.max.y - m.min.y < 0.15 && m.max.y < 0.35) return;
    b.union(m);
  });
  if (b.isEmpty() || b.min.y > 1.5) return null;
  if ((b.max.x - b.min.x) * (b.max.z - b.min.z) > maxArea) return null;
  const hx = Math.max(0.3, (b.max.x - b.min.x) / 2), hz = Math.max(0.3, (b.max.z - b.min.z) / 2);
  return { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2, hx, hz, r: Math.max(0.4, Math.hypot(hx, hz)), top: b.max.y };
}

// a small thing a figure can pick up: no figure or hold in it, fits in a hand; a house, a lamp, a sky or a pond is not
// carried, only things whose spots (a biscuit's food) can come along; but a small hand lamp (a flashlight, a lantern)
// is made to be carried: its light rides along (Sebastian, 2026-10-17)
export function isPortable({ hx, hz, top, lightKinds = [], weather = 0, spotKinds = [], actors = 0, holds = 0, heldBy = false, pond = false }) {
  if (heldBy || actors || holds) return false;
  const handLamp = lightKinds.length > 0 && lightKinds.every(k => k === 'lamp') && Math.max(hx, hz) * 2 <= 3 && Math.min(hx, hz) * 2 <= 1.4 && top < 1.5;
  if (!handLamp && (Math.max(hx, hz) * 2 > 2 || top > 2.5)) return false;
  if ((lightKinds.length && !handLamp) || weather || spotKinds.some(k => k !== 'food')) return false;
  return !pond;
}
