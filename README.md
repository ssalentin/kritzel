# Kritzel

Drawings on paper become a living 3D paper diorama.

A camera watches a sheet of paper. Every figure, house or tree drawn on it becomes a
small low-poly object on a floating island in the browser — and the characters start
living there: they walk around, meet each other, make friends or run away, talk in
speech bubbles and babble softly. Start a new sheet and the old island shrinks away
while a new one grows in.

The look is modelled on the three.js "Littlest Tokyo" example: a pastel diorama on a
soft mint backdrop, lit by a room environment, with very soft shadows and baked
contact shading.

> **Status:** prototype. The engine in `viewer/` is complete and runs on its own.
> The generation stage (`generate/`) turns a settled camera frame into `things/*.js`
> files; see [Generation](#generation).

## How it works

```
camera ──► frame ──► generation (generate/) ──────────► viewer/things/<thing>.js
                                                                  │
                                         browser polls every 0.5s │ hot reload
                                                                  ▼
                                     viewer/index.html  (three.js scene, island, sim)
```

- **`viewer/index.html`** — the engine: renderer, lights, orbit camera, speech-bubble
  sprites, hot reload, the "new world" transition, click-to-follow a character, and the
  sound toggle. It polls the server and reloads only what changed.
- **`viewer/world.js`** — builds one world: the island plus every file in `things/`.
  Things can be added, changed or removed live; every character's position, mood and
  friendships survive reloads (even a full page reload, via `sessionStorage`).
- **`viewer/island.js`** — the floating island: grass top, layered soil, rocky
  underside, roots, optional waterfall and sky.
- **`viewer/characters.js`** — character models and rigs (`makePerson`) that drawn
  figures can reuse.
- **`viewer/sim.js`** — autonomous life on the island, driven by
  [rot.js](https://ondras.github.io/rot.js/): a grid with obstacles, speed-based
  scheduling, field of view (trees block sight), A* paths, needs, fear, traits and
  relationships; goals are picked by utility.
- **`viewer/sim-extra.js`** — speech lines and interactions (chats, dances, tag,
  hiding, visiting doors, carrying keys to locks, inspecting newly drawn things).
- **`viewer/sound.js`** — procedural Web Audio sound, no sound files: Animal-Crossing
  style babble per speaker, small word-triggered effects, a quiet wind bed, all
  spatialised relative to the camera. Off until the user clicks.
- **`viewer/serve.py`** — a no-cache static server on `127.0.0.1:8765`.

The UI text is German (the world is made for drawing with kids).

## Quick start

Requirements: Python 3 and a browser with WebGL. three.js and rot.js load from a CDN.

```bash
python3 viewer/serve.py
# open http://127.0.0.1:8765/viewer/
```

The page shows an empty island until something is in `viewer/things/`. Drop a
`*.js` file in there and it appears within half a second.

Useful URL parameter: `?cam=x,y,z,tx,ty,tz` pins the camera (handy for screenshots).

### With the live camera

`scripts/start.sh [device]` starts the server and an `mpv` window on a V4L2 camera
(default `/dev/video2`, MJPEG 1080p30, with a white-balance correction for warm room
light). The mpv IPC socket (`mpv.sock`) lets a watcher grab frames while the window is
open. Needs Linux, `mpv` and a camera.

### Starting a new sheet

```bash
scripts/newworld.sh [name]
```

Archives the current world (engine files + things) to `worlds/<name>-YYYYmmdd-HHMM/`
(viewable at `/worlds/<dir>/`) and empties `viewer/things/`. The open page notices,
plays the new-world animation, and waits for the first new drawing.

## The `things/*.js` contract

Each drawn object is one ES module in `viewer/things/`:

```js
export const meta = { name: 'Haus', drawing: 'a small house with a red roof' };

export function build(ctx) {
  const { THREE, world, mat, makePerson, bubble, shadowAll, sound } = ctx;
  const house = new THREE.Group();
  // ... build meshes with mat(color), add them to house ...
  world.add(house);
  return {
    actors: [],                         // characters the sim should bring to life
    obstacles: [{ x: 2, z: 1, r: 0.8 }],// circles characters walk around
    spots: [],                          // { kind, x, z, lines } — doors, items, places to visit
    update(t, dt, env) {},              // optional per-frame animation
  };
}
```

`ctx` also carries `rand` (seeded), `limb`, `pond`, `trees`, `SUN_POS`, `islandR`
(6.9) and `env` (`env.actors` lists who is around). A thing that throws is reported in
the on-screen error box; the rest of the world keeps running.

## Generation

`generate/` turns a settled frame (a photo of the whole sheet) into modules in
`viewer/things/`. It runs headless Claude Code (`claude -p`) on this machine's existing
Claude Code login, so it needs no API key. Each call runs with `--restricted`: no shell, no
web, and only the images for that call are readable. The frame comes from whoever draws on
the paper, so writing on it is treated as part of the drawing.

```bash
cd generate && npm install
node generate.mjs --watch                       # every new frames/settled/<ts>.jpg → viewer/things/
node generate.mjs frame.jpg --things /tmp/t     # one frame, into a scratch things/ dir
npm test                                        # the offline checks
```

For each frame:

1. **Understand.** Claude lists every drawing on the sheet as new, changed or unchanged,
   matched against the existing things' `meta` (which doubles as the registry). A mark it
   cannot read with confidence (a bare outline, a scribble) goes to `unclear` and produces
   nothing. A wrong thing on the island is worse than no thing.
2. **Write.** One module per new or changed drawing, placed on the island where it sits on
   the paper. The prompt carries the contract and two reference things in
   `generate/examples/`.
3. **Check.** A static check forbids anything outside `ctx` (imports, network, page
   globals, eval, file loaders). Then `build(ctx)` runs for real in Node with three.js, and
   the result must be visible, on the island, with valid actors (unique id; non-person rigs
   bring their own `animate`), obstacles, spots and a working `update`.
4. **Render and look.** Headless Chromium renders the thing in the real viewer, and Claude
   compares the render with the drawing: same kind of thing, the drawn features, nothing
   big added. Failed checks go back to step 2 with the problems and the render (3 attempts).

Only a module that passes everything is written, atomically, to `things/`. Each frame
leaves a report in `frames/generated/<frame>.json` (what was understood, written,
rejected and why, unclear marks) next to the render PNGs. A changed drawing rewrites its
module and keeps its actor id, so the sim keeps its friendships. Not automatic yet:
removing a thing whose drawing was erased, and archiving the world when a new sheet
appears (both are only reported). `KRITZEL_MODEL` overrides the model
(default `claude-opus-5-5`).

## Repository layout

```
viewer/          the engine (served at /viewer/)
viewer/things/   one module per drawn object (empty in the repo)
generate/        the generation stage: frame → things/*.js
scripts/         start.sh (server + camera window), newworld.sh (archive + reset)
BACKLOG.md       ideas and requests that are not scheduled work yet
```

## Credits

Built with [three.js](https://threejs.org/) and [rot.js](https://ondras.github.io/rot.js/).
