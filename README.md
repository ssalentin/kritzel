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

### Choosing a camera

The 📷 button in the viewer opens a camera picker with a live preview:

- **Dieser Computer:** cameras of the machine the browser runs on. Browsers allow
  this only on `https://` or `localhost`.
- **Im Netzwerk:** cameras on any online Tailscale peer that runs
  `python3 scripts/camera_server.py` (port 8766; Linux, V4L2 and ffmpeg). The viewer's
  server finds them and passes the streams through, so they work under https too.

The choice is stored in `camera.json` at the repository root for the capture stage.
`HOST`/`PORT` env vars change where `viewer/serve.py` listens.

### Capturing drawings

```bash
python3 scripts/capture.py
```

Watches the camera chosen in `camera.json` (network cameras for now) through the viewer's
server and waits until the picture holds still. When the sheet shows something new, it
writes `frames/settled/<YYYYmmdd-HHMMSS>.json` and then the camera's frame as
`<same>.jpg`. The JSON gives `previous` (the last frame handed on), `reason` (`drawn`, or
`big-change` for a new or moved sheet), and `changed_box` (where the change is, in
pixels). Nothing is written while a hand moves over the paper or when nothing changed. Watch for the
`.jpg`: it is renamed in last, so its `.json` is always there already.

Keep the paper inside the camera's view: capture ignores the outer edge of the frame
(about 60 px at 1080p), so a drawing made only there is never handed on. A sheet that
slides or turns a little is aligned first and doesn't count as new.

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

`generate/` turns each settled frame from the capture stage into modules in
`viewer/things/`. It runs headless Claude Code (`claude -p`) on this machine's existing
Claude Code login, so it needs no API key (`--bare` can't be used: it ignores that login).

```bash
cd generate && npm install
node generate.mjs --watch --render              # every new frames/settled/<ts>.jpg → viewer/things/
../scripts/dev.sh                               # or: viewer server + capture + generate in one go
node generate.mjs frame.jpg --box x,y,w,h --things /tmp/t   # one frame, into a scratch things/ dir
npm test                                        # the offline checks
```

For each frame:

1. **One call.** The frame is cropped to capture's `changed_box` (plus a margin) and scaled
   to at most 768 px (1568 px for a whole sheet without a trusted box). One `claude -p` call (default `claude-sonnet-5-5`, `KRITZEL_MODEL` to
   change) gets the crop inline, all tools off, and a short system prompt with the contract
   and one example (`generate/examples/`). The existing modules' code is in the request. The
   reply is `NOTHING`, or one section per change: `### NEW` (a module), `### UPDATE <file>`
   (the new version of a thing whose drawing changed; it keeps its file and actor id, so the
   sim keeps its friendships), `### REMOVE <file>` (its drawing was erased), or `### UNCLEAR`
   for a mark that could be many things. The model sees the changed area before and now, so
   it can tell what was erased; without a before picture nothing is removed, and only a thing
   whose `meta.paper` lies in the changed area can be (hand-made things without it stay). A removed module
   is moved to `frames/removed/`, so undoing a wrong removal is one `mv`. Unclear
   marks produce nothing, because a wrong thing on the island is worse than none. Text on the
   paper is treated as part of the drawing.
2. **Checks.** A static check catches the model reaching outside `ctx` (imports, network,
   page globals, eval, Node). It guards against mistakes, not attacks. Then `build(ctx)` runs
   for real with three.js, sandboxed: in a child with no network (`unshare --net`), under
   `node --permission` (no file writes, no child processes), killed after 10 s. The result
   must be visible, on the island, with valid actors (unique id; non-person rigs bring their
   own `animate`), obstacles, spots, and an `update` that survives 30 simulated seconds. A
   module that fails gets one fix attempt on the same model and one on `claude-opus-5-5`.
3. **Write.** Each passing module is written atomically to `things/`. `--render` then
   screenshots it in the real viewer (headless Chromium), off the critical path.

Each frame leaves a report in `frames/generated/<frame>.json` with the reply, each call's
model, seconds and cost, what was written or rejected and why, and the seconds from the
settled frame to the written file. The watcher resumes after the newest frame with a
finished report. A failing frame gets 3 tries with backoff, then it is marked failed.

Not automatic yet: archiving the world when a new sheet appears (it is only reported).
Placement uses the camera frame, not a detected paper outline.

## Repository layout

```
viewer/          the engine (served at /viewer/)
viewer/things/   one module per drawn object (empty in the repo)
generate/        the generation stage: frame → things/*.js
scripts/         start.sh (server + camera window), dev.sh (server + capture + generate),
                 capture.py (camera → frames/settled/), camera_server.py (shares a camera),
                 newworld.sh (archive + reset)
BACKLOG.md       ideas and requests that are not scheduled work yet
```

## Credits

Built with [three.js](https://threejs.org/) and [rot.js](https://ondras.github.io/rot.js/).
