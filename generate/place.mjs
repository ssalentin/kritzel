// paper position (0..1, top-left origin) → the open book's pages (x, z), the same mapping the viewer uses:
// the sheet fills both pages; the paper's top is the far edge (-z), the spine runs down the middle (x = 0)
export function islandOf(px, py) {
  const x = Math.min(6.3, Math.max(-6.3, (px - 0.5) * 12.6)), z = Math.min(4.5, Math.max(-4.5, (py - 0.5) * 9));
  return [+x.toFixed(2), +z.toFixed(2)];
}

// a paper position (0..1 of the frame) moved by capture's sheet transform: affine [a, b, c, d, e, f]
// maps the previous frame's pixels to this frame's (x' = a x + b y + c, y' = d x + e y + f)
export function movePaper(p, affine, W = 1920, H = 1080) {
  const [a, b, c, d, e, f] = affine, x = p.x * W, y = p.y * H;
  return { x: +((a * x + b * y + c) / W).toFixed(4), y: +((d * x + e * y + f) / H).toFixed(4) };
}
