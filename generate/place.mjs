// paper position (0..1, top-left origin) → island (x, z): the paper's top is the island's back (-z)
export function islandOf(px, py) {
  let ix = (px - 0.5) * 9, iz = (py - 0.5) * 7;
  const r = Math.hypot(ix, iz);
  if (r > 5) { ix *= 5 / r; iz *= 5 / r; }
  return [+ix.toFixed(2), +iz.toFixed(2)];
}

// a paper position (0..1 of the frame) moved by capture's sheet transform: affine [a, b, c, d, e, f]
// maps the previous frame's pixels to this frame's (x' = a x + b y + c, y' = d x + e y + f)
export function movePaper(p, affine, W = 1920, H = 1080) {
  const [a, b, c, d, e, f] = affine, x = p.x * W, y = p.y * H;
  return { x: +((a * x + b * y + c) / W).toFixed(4), y: +((d * x + e * y + f) / H).toFixed(4) };
}
