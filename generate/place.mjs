// paper position (0..1, top-left origin) → island (x, z): the paper's top is the island's back (-z)
export function islandOf(px, py) {
  let ix = (px - 0.5) * 9, iz = (py - 0.5) * 7;
  const r = Math.hypot(ix, iz);
  if (r > 5) { ix *= 5 / r; iz *= 5 / r; }
  return [+ix.toFixed(2), +iz.toFixed(2)];
}
