// Reference for drawn creatures that are not people: own body, own rig.animate.
export const meta = { name: 'Schnecke', drawing: 'a snail with a round spiral shell, two feelers and a happy face', paper: { x: 0.3, y: 0.6 } };

export function build(ctx) {
  const { THREE, world, mat, bubble, shadowAll } = ctx;
  const soft = (c, o = {}) => mat(c, { flatShading: false, roughness: 0.55, ...o });
  const g = new THREE.Group();
  const body = new THREE.Group();                 // everything that bobs and squashes
  g.add(body);

  const skin = soft(0xc9e08a);
  const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 6, 16), skin);
  foot.rotation.x = Math.PI / 2; foot.scale.set(1, 1, 0.55); foot.position.y = 0.12;
  const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.35, 6, 12), skin);
  neck.position.set(0, 0.42, 0.5);
  // the shell: a fat disc seen from the side, with the drawn spiral as rings on both faces
  const shell = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), soft(0xe8a35c));
  disc.scale.set(0.55, 1, 1);
  shell.add(disc);
  for (const s of [-1, 1]) for (const [r, k] of [[0.3, 0], [0.18, 1], [0.08, 2]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.028, 6, 24), soft(0xb8743a));
    ring.position.set(s * (0.2 + k * 0.025), 0.02 * k, 0.03 * k); ring.rotation.y = Math.PI / 2;
    shell.add(ring);
  }
  shell.position.set(0, 0.6, -0.15);
  body.add(foot, neck, shell);

  const head = new THREE.Group();
  head.position.set(0, 0.7, 0.55);
  const eyeM = soft(0x1b1b22, { roughness: 0.25 });
  for (const s of [-1, 1]) {
    const feeler = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.4, 6), skin);
    feeler.position.set(s * 0.09, 0.2, 0); feeler.rotation.z = -s * 0.25;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), eyeM);
    tip.position.y = 0.2; feeler.add(tip);
    head.add(feeler);
  }
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.014, 6, 12, Math.PI), soft(0x6a2a2a));
  smile.rotation.z = Math.PI; smile.position.set(0, -0.05, 0.17);
  head.add(smile);
  body.add(head);

  g.position.set(-2, 0, 1);
  shadowAll(g);
  world.add(g);
  const b = bubble(g, 1.6);

  // the sim calls animate(state, t, moving, actor) every frame; states: idle, walk, talk, wave,
  // dance, sit, scared, highfive, lookup, yawn, stretch (unknown ones: treat like idle)
  function animate(state, t) {
    body.position.y = 0; body.scale.set(1, 1, 1); head.rotation.set(0, 0, 0);
    if (state === 'walk') body.scale.z = 1 + Math.sin(t * 8) * 0.08;               // a snail creeps: stretch and squash
    else if (state === 'dance') body.position.y = Math.abs(Math.sin(t * 6)) * 0.2;
    else if (state === 'scared') { body.scale.y = 0.8; head.position.z = 0.4; return; }   // pulls in
    else if (state === 'talk') head.rotation.z = Math.sin(t * 5) * 0.12;
    else if (state === 'lookup') head.rotation.x = -0.5;
    else body.scale.y = 1 + Math.sin(t * 1.5) * 0.02;                                // breathing
    head.position.z = 0.55;
  }

  return {
    actors: [{
      id: 'schnecke', name: 'Schnecke', start: [-2, 1], speed: 0.45,
      traits: { curiosity: 0.8, sociable: 0.7, bravery: 0.3 },
      rig: { kind: 'schnecke', g, say: t => b.say(t), animate },
      lines: { greet: ['Hallooo…', 'Schön langsam!'], chat: ['Ich trage mein Haus immer mit.', 'Kein Grund zur Eile.'] },
    }],
    obstacles: [],
    spots: [],
  };
}
