// The world's ground: an open pop-up book. Two paper pages with a faint grain, curving down
// into the spine, on page stacks and a cloth cover. Things stand on the pages (y = 0); the
// ground every part of the engine uses is the pages' rectangle, GROUND.

// the pages' rectangle now: starts at BASE and grows with the number of things and figures (sizeFor),
// up to GROUND_MAX. x −w/2…w/2 (spine at x = 0), z −d/2…d/2. Mutated in place, so every module sees it.
export const BASE = { w: 18, d: 13 };
export const GROUND_MAX = { w: 30, d: 22 };
export const GROUND = { shape: 'rect', w: BASE.w, d: BASE.d };
// the book for `count` things and figures: its area grows with the count (a cosy book when it's
// nearly empty), keeps its proportions, and stops at GROUND_MAX
export function sizeFor(count) {
  const s = Math.min(Math.sqrt(GROUND_MAX.w * GROUND_MAX.d / (BASE.w * BASE.d)), Math.sqrt(1 + Math.max(0, count) / 20));
  return { w: BASE.w * s, d: BASE.d * s };
}
// the pages' height across the book: rising gently toward the spine, dipping into the gutter at
// x = 0, and lifting a little at the outer edges, like an open book lying on a table. Things and
// characters stand at groundY(x).
export function groundY(x) {
  // the page is scaled with the book, so the base curve is read at x / (book scale): the same height at the same place on the page
  const xb = x * BASE.w / GROUND.w;
  const u = Math.min(1, Math.abs(xb) / (BASE.w / 2));          // 0 at the spine, 1 at the outer edge
  return 0.18 * (1 - u) ** 1.5 + 0.08 * Math.exp(-((((1 - u) * BASE.w / 2) / 0.5) ** 2)) - 0.45 * Math.exp(-((xb / 0.55) ** 2));
}
// the circle that fits on the pages, for things written for the old round island (ctx.islandR)
export const FIT_R = Math.min(BASE.w, BASE.d) / 2;

// inside the pages, with `margin` to spare (a point, or a circle of radius r)
export const onGround = (x, z, r = 0, margin = 0) =>
  Math.abs(x) + r <= GROUND.w / 2 - margin && Math.abs(z) + r <= GROUND.d / 2 - margin;
// the nearest point on the pages
export const clampToGround = (p, margin = 0.3) => {
  p.x = Math.max(-GROUND.w / 2 + margin, Math.min(GROUND.w / 2 - margin, p.x));
  p.z = Math.max(-GROUND.d / 2 + margin, Math.min(GROUND.d / 2 - margin, p.z));
  return p;
};

export function buildBook({ THREE, world }) {
  const W = BASE.w, D = BASE.d, half = W / 2;      // built at its base size; world.js scales the group as it grows
  const g = new THREE.Group();

  // paper: warm white with fibres and a few faint ruled lines, drawn once
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c = cv.getContext('2d');
  c.fillStyle = '#f4ecdc'; c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) {
    c.fillStyle = `rgba(${150 + Math.random() * 60},${130 + Math.random() * 50},${100 + Math.random() * 40},${0.04 + Math.random() * 0.05})`;
    c.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 6, 1);
  }
  const paper = new THREE.CanvasTexture(cv);
  paper.colorSpace = THREE.SRGBColorSpace;
  paper.wrapS = paper.wrapT = THREE.RepeatWrapping;
  paper.repeat.set(2, 3);
  const pageMat = new THREE.MeshStandardMaterial({ map: paper, roughness: 0.95, side: THREE.DoubleSide });

  // a page: flat where things stand, dipping into the gutter near the spine
  for (const side of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(half, D, 40, 4);
    geo.rotateX(-Math.PI / 2);
    geo.translate(side * half / 2, 0, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, groundY(pos.getX(i)));
    geo.computeVertexNormals();
    const page = new THREE.Mesh(geo, pageMat);
    page.receiveShadow = true;
    g.add(page);

    // the stack of pages under it: a block with fine lines along its edges
    const ecv = document.createElement('canvas');
    ecv.width = 8; ecv.height = 64;
    const ec = ecv.getContext('2d');
    for (let y = 0; y < 64; y++) { ec.fillStyle = y % 4 < 2 ? '#e9dfc9' : '#d9cdb3'; ec.fillRect(0, y, 8, 1); }
    const edges = new THREE.CanvasTexture(ecv);
    edges.colorSpace = THREE.SRGBColorSpace;
    // (it stops short of the spine, where the page dips into the gutter over it)
    const stack = new THREE.Mesh(new THREE.BoxGeometry(half - 1.05, 0.42, D - 0.1),
      new THREE.MeshStandardMaterial({ map: edges, roughness: 0.9 }));
    stack.position.set(side * (1 + (half - 1.05) / 2), -0.23, 0);
    stack.castShadow = stack.receiveShadow = true;
    g.add(stack);
  }

  // the cover: cloth-bound boards a little larger than the pages, and the rounded spine
  const cloth = new THREE.MeshStandardMaterial({ color: 0x8a3f3a, roughness: 0.85 });
  for (const side of [-1, 1]) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(half + 0.35, 0.12, D + 0.5), cloth);
    board.position.set(side * (half / 2 + 0.12), -0.5, 0);
    board.castShadow = board.receiveShadow = true;
    g.add(board);
  }
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, D + 0.5, 20, 1, false, Math.PI / 2, Math.PI), cloth);
  spine.rotation.x = Math.PI / 2;
  spine.position.set(0, -0.5, 0);
  g.add(spine);

  g.userData.book = true;                // the page turn folds everything else flat, not this
  world.add(g);
  return { group: g, ground: GROUND, update() {} };
}
