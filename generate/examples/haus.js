// Reference for drawn objects that stand still: an obstacle to walk around, a door to visit.
export const meta = { name: 'Haus', drawing: 'a small house with a red triangle roof, a door and one window', paper: { x: 0.7, y: 0.3 } };

export function build(ctx) {
  const { THREE, world, mat, shadowAll } = ctx;
  const house = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.3, 1.4), mat(0xf3e3c3));
  walls.position.y = 0.65;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.35, 0.9, 4), mat(0xd9534a));
  roof.position.y = 1.75; roof.rotation.y = Math.PI / 4;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 0.05), mat(0x8a5a3b));
  door.position.set(0, 0.35, 0.71);
  const win = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.05), mat(0x9fd3f0, { roughness: 0.2 }));
  win.position.set(0.5, 0.85, 0.71);
  house.add(walls, roof, door, win);
  house.position.set(2.5, 0, -1.5);
  shadowAll(house);
  world.add(house);
  return {
    actors: [],
    obstacles: [{ x: 2.5, z: -1.5, r: 1.1 }],
    // a door: characters walk up, knock, go in for a rest (x/z: right in front of the door)
    spots: [{ kind: 'door', x: 2.5, z: -0.6, lines: ['Klopf klopf!'] }],
  };
}
