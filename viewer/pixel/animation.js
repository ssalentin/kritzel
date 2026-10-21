// Whole-frame strip selection. Every returned frame is imageWidth / frames wide; nothing is cut apart.
export function stripFrame(imageWidth, imageHeight, { frames = 1, fps = 8, state = 'idle', now = 0 } = {}) {
  const wanted = Math.max(1, Math.round(+frames || 1));
  const count = imageWidth > 0 && imageWidth % wanted === 0 ? wanted : 1;
  const rate = Math.max(1, +fps || 8);
  const index = state === 'move' && count > 1 ? Math.floor(now / 1000 * rate) % count : 0;
  return { count, index, width: imageWidth / count, height: imageHeight };
}
