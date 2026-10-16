// The world's ground: an open pop-up book. Two paper pages with a faint grain, curving down
// into the spine, on page stacks and a cloth cover. Things stand on the pages (y = 0); the
// ground every part of the engine uses is the pages' rectangle, GROUND.

export const GROUND = { shape: 'rect', w: 14, d: 10 };          // x −7…7 (spine at x = 0), z −5…5
// the circle that fits on the pages, for things written for the old round island (ctx.islandR)
export const FIT_R = Math.min(GROUND.w, GROUND.d) / 2;

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
  const W = GROUND.w, D = GROUND.d, half = W / 2;
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
  const dip = x => -0.28 * Math.exp(-((x / 0.7) ** 2));
  for (const side of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(half, D, 40, 4);
    geo.rotateX(-Math.PI / 2);
    geo.translate(side * half / 2, 0, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, dip(pos.getX(i)));
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

  world.add(g);
  return { group: g, ground: GROUND, update() {} };
}
