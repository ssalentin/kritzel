// Character models from the drawing: people (wanderer + companions) and Sqichy
// the squid knight. The rig fields returned here are what sim.js animates:
// limbs are pivot Groups at shoulder/hip with the mesh hanging down along -y.
export function makeCharacters({ THREE, world, mat, limb, bubble, shadowAll }) {
  const soft = (c, o = {}) => mat(c, { flatShading: false, roughness: 0.55, ...o });
  const skin = soft(0xf6cfa8), eyeM = soft(0x1b1b22, { roughness: 0.25 }), shine = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const blush = soft(0xff8a8a, { transparent: true, opacity: 0.5 });
  const ball = (r, m, x = 0, y = 0, z = 0, w = 16, h = 12) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, w, h), m);
    s.position.set(x, y, z);
    return s;
  };

  // ---------- people: the wanderer and the two companions ----------
  function makePerson({ shirtColor, scale = 1, hat = null, pantsColor = 0x34405e, hairColor = 0x5a3825 }) {
    const shirt = soft(shirtColor), pants = soft(pantsColor), shoeM = soft(0x4a3426, { roughness: 0.7 });
    const g = new THREE.Group();
    const body = new THREE.Group();          // everything above the hips
    g.add(body);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.6, 6, 16), shirt);
    torso.position.y = 1.25;
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.226, 0.226, 0.06, 16), soft(0x5b3a22));
    belt.position.y = 0.98;
    const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.06, 4, 12), pants);
    hips.position.y = 0.93;
    g.add(hips);

    const head = new THREE.Group();
    head.position.y = 1.9;
    head.add(ball(0.29, skin, 0, 0, 0, 24, 18));
    for (const sx of [-1, 1]) {
      const e = ball(0.042, eyeM, sx * 0.1, 0.04, 0.255, 10, 8);
      e.add(ball(0.014, shine, 0.012, 0.016, 0.034, 6, 4));
      head.add(e, ball(0.06, skin, sx * 0.285, 0, 0, 10, 8));
      const c = ball(0.055, blush, sx * 0.17, -0.06, 0.23, 10, 8);
      c.scale.z = 0.35; c.lookAt(sx * 0.6, -0.2, 0.8);
      head.add(c);
    }
    head.add(ball(0.04, skin, 0, -0.02, 0.29, 10, 8));
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.013, 6, 12, Math.PI), soft(0x8a3a3a));
    smile.rotation.z = Math.PI; smile.position.set(0, -0.08, 0.26);
    head.add(smile);
    const hair = soft(hairColor, { roughness: 0.8 });
    if (hat !== 'spiky') {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.305, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), hair);
      cap.rotation.x = -0.35; cap.position.set(0, 0.02, -0.02);
      head.add(cap);
    }
    if (hat === 'tophat') {
      const black = soft(0x1c1c24, { roughness: 0.35 });
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.04, 28), black); brim.position.y = 0.24;
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.24, 0.45, 28), black); crown.position.y = 0.48;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.247, 0.245, 0.08, 28), soft(0xc8372d)); band.position.y = 0.31;
      const pin = ball(0.04, soft(0xffd54a, { metalness: 0.5, roughness: 0.3 }), 0.12, 0.31, 0.2, 8, 6);
      head.add(brim, crown, band, pin);
    } else if (hat === 'spiky') {
      const orange = soft(0xf0922f, { roughness: 0.7 });
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.305, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), orange);
      cap.rotation.x = -0.3;
      head.add(cap);
      for (let i = 0; i < 9; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.36, 8), orange);
        const a = -1.2 + i * 0.3;
        spike.position.set(Math.sin(a) * 0.22, 0.24 + Math.cos(a) * 0.04, -0.06 + (i % 2) * 0.08);
        spike.rotation.set((i % 2) * -0.3, 0, -a * 0.9);
        head.add(spike);
      }
    }

    const arm = () => {
      const p = limb(0.7, 0.062, skin);
      const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.16, 4, 10), shirt);
      sleeve.position.y = -0.12;
      p.add(sleeve);
      p.elbow.add(ball(0.08, skin, 0, -0.35, 0, 12, 8));
      return p;
    };
    const leg = () => {
      const p = limb(0.85, 0.09, pants);
      const shoe = ball(0.11, shoeM, 0, -0.395, 0.06, 14, 10);
      shoe.scale.set(1, 0.6, 1.5);
      p.elbow.add(shoe);
      return p;
    };
    const armL = arm(), armR = arm();
    armL.position.set(-0.3, 1.55, 0); armR.position.set(0.3, 1.55, 0);
    const legL = leg(), legR = leg();
    legL.position.set(-0.12, 0.88, 0); legR.position.set(0.12, 0.88, 0);
    body.add(torso, belt, head, armL, armR);
    g.add(legL, legR);
    g.scale.setScalar(scale);
    shadowAll(g);
    for (const c of head.children) if (c.material === blush) c.castShadow = false;
    world.add(g);
    const b = bubble(g, 2.45);
    return { kind: 'person', g, body, head, armL, armR, legL, legR, say: t => b.say(t) };
  }

  // ---------- Sqichy, the squid knight ----------
  function makeSquid() {
    const g = new THREE.Group();
    const bodyM = soft(0xb06ad6, { roughness: 0.4 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), bodyM);
    body.scale.set(1, 0.95, 0.9);
    body.position.y = 1.6;
    g.add(body);
    const spotM = soft(0x9150c4, { roughness: 0.45 }), Z = new THREE.Vector3(0, 0, 1);
    for (const [x, y, z, r] of [[0.5, 0.6, -0.5, 0.18], [-0.6, 0.4, -0.55, 0.14], [0.1, 0.85, -0.3, 0.12], [-0.85, -0.1, -0.3, 0.16], [0.9, 0.05, -0.15, 0.11], [-0.2, 0.3, -0.92, 0.2]]) {
      const d = new THREE.Vector3(x, y, z).normalize();
      const s = ball(r, spotM, d.x * 0.985, d.y * 0.985, d.z * 0.985, 14, 10);
      s.quaternion.setFromUnitVectors(Z, d); s.scale.z = 0.25;
      body.add(s);
    }
    const belly = ball(0.55, soft(0xbf80e0, { roughness: 0.45 }), 0, -0.6, 0.62, 24, 16);
    belly.scale.set(1, 0.6, 0.35);
    belly.rotation.x = 0.6;
    body.add(belly);
    const eyes = [];
    for (const s of [-1, 1]) {
      const white = ball(0.2, soft(0xffffff, { roughness: 0.3 }), s * 0.33, 0.3, 0.78, 20, 14);
      const pupil = ball(0.1, eyeM, 0, 0, 0.13, 14, 10);
      pupil.add(ball(0.032, shine, 0.035, 0.04, 0.075, 8, 6));
      white.add(pupil);
      body.add(white);
      eyes.push(white);
      const c = ball(0.13, blush, s * 0.58, -0.08, 0.72, 12, 8);
      c.scale.z = 0.3; c.lookAt(s * 3, -0.5, 3);
      body.add(c);
    }
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 14).scale(1, 0.75, 0.45), soft(0x5a1236, { roughness: 0.5 }));
    mouth.position.set(0, -0.2, 0.85);
    const tongue = ball(0.1, soft(0xff7a9a), 0, -0.07, 0.04, 12, 8);
    tongue.scale.set(1, 0.5, 0.6);
    mouth.add(tongue);
    body.add(mouth);

    const hat = new THREE.Group();
    const red = mat(0xd63a2f, { roughness: 0.55 }), gold = soft(0xe8b923, { metalness: 0.6, roughness: 0.3 });
    const hatBody = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.5, 0.9, 4), red);
    hatBody.rotation.y = Math.PI / 4;
    hatBody.position.y = 0.45;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.535, 0.528, 0.12, 4), gold);
    band.rotation.y = Math.PI / 4; band.position.y = 0.14;
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), soft(0x4fc3f7, { metalness: 0.3, roughness: 0.1 }));
    gem.position.set(0, 0.14, 0.4); gem.scale.z = 0.5;
    const brim = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.06, 1.0), mat(0x9e2b22));
    hat.add(hatBody, band, gem, brim);
    const tufts = [];
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.35, 8), soft(0xffd54a));
      t.position.set(-0.3 + i * 0.2, 1.05, 0);
      t.add(ball(0.06, soft(0xffe27a), 0, 0.19, 0, 10, 8));
      hat.add(t);
      tufts.push(t);
    }
    hat.position.y = 2.45;
    g.add(hat);

    const tentacles = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      let parent = new THREE.Group();
      parent.position.set(Math.cos(a) * 0.55, 0.85, Math.sin(a) * 0.5);
      parent.rotation.y = -a + Math.PI / 2;
      g.add(parent);
      const segs = [];
      for (let k = 0; k < 4; k++) {
        const seg = limb(0.28, 0.12 - k * 0.022, bodyM);
        if (k > 0) seg.position.y = -0.24;
        if (k === 3) seg.add(ball(0.05, bodyM, 0, -0.26, 0, 10, 8));
        parent.add(seg);
        segs.push(seg);
        parent = seg;
      }
      tentacles.push({ segs, phase: i * 1.1 });
    }

    const swordArm = limb(0.8, 0.1, bodyM);
    swordArm.position.set(0.9, 1.75, 0.1);
    const sword = new THREE.Group();
    const steel = soft(0xeef3f8, { metalness: 0.75, roughness: 0.2 });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.75, 0.045), steel);
    blade.position.y = 0.98;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 4).rotateY(Math.PI / 4).scale(1, 1, 0.32), steel);
    tip.position.y = 1.98;
    const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.5, 0.05), soft(0xb8c4d0, { metalness: 0.8, roughness: 0.3 }));
    fuller.position.y = 0.95;
    const guard = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.32, 4, 8).rotateZ(Math.PI / 2), gold);
    guard.position.y = 0.08;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8), soft(0x5a3a1a, { roughness: 0.8 }));
    grip.position.y = -0.04;
    sword.add(blade, tip, fuller, guard, grip, ball(0.06, gold, 0, -0.16, 0, 10, 8));
    sword.position.y = -0.8;
    swordArm.add(sword);
    g.add(swordArm);

    g.scale.setScalar(0.8);
    shadowAll(g);
    body.traverse(o => { if (o.material === blush) o.castShadow = false; });
    world.add(g);
    bubble(g, 3.75, { name: true }).say('Sqichy');
    const b = bubble(g, 4.35);
    return { kind: 'squid', g, body, mouth, eyes, tufts, tentacles, swordArm, say: t => b.say(t) };
  }

  return { makePerson, makeSquid };
}
