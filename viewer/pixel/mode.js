// The tab's 3D | Pixel choice. Kept here so the 3D viewer and the pixel app agree on the key.
export const PIXEL_KEY = 'kritzelPixelMode';
export function readPixelMode(storage = globalThis.sessionStorage) {
  try { return storage?.getItem(PIXEL_KEY) === '1'; } catch { return false; }
}
export function savePixelMode(storage, on) {
  try { storage?.setItem(PIXEL_KEY, on ? '1' : '0'); } catch { /* private mode: no memory */ }
}
