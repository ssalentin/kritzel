// The world is an open pop-up book (viewer/book.js): two pages x -BOOK.x..BOOK.x (spine at x = 0),
// z -BOOK.z..BOOK.z, ground y = 0. The paper frame fills both pages, mapped the same way the viewer does.
// (check-run.mjs runs sandboxed and keeps its own copy of BOOK.x / BOOK.z.)
export const BOOK = { x: 9, z: 6.5, kx: 16.6, kz: 12, cx: 8.3, cz: 6 };
// paper position (0..1, top-left origin) → the book's pages (x, z); the paper's top is the far edge (-z)
export function islandOf(px, py) {
  const x = Math.min(BOOK.cx, Math.max(-BOOK.cx, (px - 0.5) * BOOK.kx)), z = Math.min(BOOK.cz, Math.max(-BOOK.cz, (py - 0.5) * BOOK.kz));
  return [+x.toFixed(2), +z.toFixed(2)];
}

// a paper position (0..1 of the frame) moved by capture's sheet transform: affine [a, b, c, d, e, f]
// maps the previous frame's pixels to this frame's (x' = a x + b y + c, y' = d x + e y + f)
export function movePaper(p, affine, W = 1920, H = 1080) {
  const [a, b, c, d, e, f] = affine, x = p.x * W, y = p.y * H;
  return { x: +((a * x + b * y + c) / W).toFixed(4), y: +((d * x + e * y + f) / H).toFixed(4) };
}
