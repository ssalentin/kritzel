// The hand cursor: two drawn glove frames (open and pinching), cross-faded over ~120 ms with a
// small scale pop. The sprites always face the camera, so the silhouette reads from every orbit
// angle. The index fingertip is the sprite's anchor: the hand body sits right of the pointer.
// Both frames are the same white glove with a dark outline; the pinch frame curves the thumb to
// the index tip and shortens the other three fingers.
export function createHand(THREE) {
  const loader = new THREE.TextureLoader();
  const sprite = (file, cx, cy) => {
    const tex = loader.load(new URL(file, import.meta.url).href);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    s.center.set(cx, cy); s.scale.set(1.35, 1.35, 1);
    s.renderOrder = 30; s.layers.set(1);
    return s;
  };
  const root = new THREE.Group();
  const open = sprite('./glove-open.png', 0.34, 0.152);    // 174,434 of 512
  const pinch = sprite('./glove-pinch.png', 0.34, 0.145);  // 174,438 of 512
  root.add(open, pinch);
  open.material.opacity = 1; pinch.material.opacity = 0; pinch.visible = false;

  let pinchK = 0, pose = 'idle', openedAt = -9, prevCarry = false;
  const api = {
    group: root,
    get pinch() { return pinchK; },
    get pose() { return pose; },
    update(dt, t, { carrying = false, pressing = false, moving = false } = {}) {
      if (prevCarry && !carrying) openedAt = t;
      prevCarry = carrying;
      const target = carrying ? 1 : 0;
      pinchK += (target - pinchK) * (1 - Math.exp(-dt / (carrying ? 0.06 : 0.075)));
      pose = carrying ? 'pinch' : pressing ? 'press' : t - openedAt < 0.2 ? 'open' : 'idle';
      const pop = 1 + 0.06 * Math.sin(Math.min(1, pinchK) * Math.PI);
      const scale = 1.35 * pop;
      const tilt = (moving ? Math.sin(t * 1.7) * 0.02 : 0) + 0.03 * pinchK;
      const lift = 0.02 * pinchK + (moving ? Math.sin(t * 1.3) * 0.008 : 0);
      for (const s of [open, pinch]) {
        s.scale.set(scale, scale, 1);
        s.position.y = lift;
        s.material.rotation = tilt;
      }
      open.material.opacity = 1 - pinchK;
      pinch.material.opacity = pinchK;
      open.visible = pinchK < 0.99;
      pinch.visible = pinchK > 0.01;
    },
  };
  return api;
}
