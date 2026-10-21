// The same paper-to-page placement serves the generated fallback scene and the live per-thing renderer.
export const SCENE = { w: 320, h: 200 };

export function label(name) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'SS')
    .toUpperCase().replace(/[^A-Z0-9 .,!?-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 14) || 'THING';
}

export function layoutThings(things) {
  const ordered = things.slice().sort((a, b) => (a.paper?.y ?? .5) - (b.paper?.y ?? .5)
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const spread = ordered.map(t => t.paper).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const box = spread.length ? {
    x0: Math.min(...spread.map(p => p.x)), x1: Math.max(...spread.map(p => p.x)),
    y0: Math.min(...spread.map(p => p.y)), y1: Math.max(...spread.map(p => p.y)),
  } : null;
  return ordered.map(t => {
    const p = t.paper || { x: .5, y: .5 };
    const u = box && box.x1 - box.x0 > .05 ? Math.max(0, Math.min(1, (p.x - box.x0) / (box.x1 - box.x0))) : p.x;
    const v = box && box.y1 - box.y0 > .05 ? Math.max(0, Math.min(1, (p.y - box.y0) / (box.y1 - box.y0))) : p.y;
    const raw = box && box.x1 - box.x0 > .05 ? (u < .5 ? 30 + u * 200 : 190 + (u - .5) * 200) : 32 + u * 256;
    const tag = label(t.name), half = Math.ceil(tag.length * 4 / 2);
    const leftPage = raw < 150;
    const cx = leftPage ? Math.max(16 + half, Math.min(149 - half, raw))
      : Math.max(169 + half, Math.min(304 - half, raw));
    return { ...t, tag, cx: Math.round(cx), cy: Math.round(64 + v * 82) };
  });
}
