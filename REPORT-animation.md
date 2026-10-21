# Whole-frame animated sprite strips — report

Worktree `/root/code/kritzel/.worktrees/sprite-animation`, branch
`sprite-animation`, from `camera-select` `986b07a`.

## What changed

- Actors now get a horizontal strip of complete frames, selected by `move`:
  walk 4 (contact / down / pass / up), fly 3 (wing up / level / down), swim 3,
  hop 2, climb/roll 4. Scenery stays one frame. The Pixel viewer has no crawl
  mover, so an explicit 3D `crawl` request is normalized to `walk`.
- Every frame is a whole 32×N grid. The model returns `FRAME 1` … `FRAME N`
  sections; the parser validates every row/colour/coverage, rejects identical
  frames (no static copies), and allows one fix before failing visibly.
  Giraffe/rider actors may use 32×48; a transparent edge padding row is
  trimmed as padding, never as a cut-up figure.
- claude-pxl (pinned `21fee41`) renders each whole frame; ImageMagick assembles
  the deterministic strip (metadata stripped) as `<base>.png`; the multi-frame
  `.px.js` source and strip are published atomically.
- Pixel thing JSON now carries
  `{name,paper,drawing,kind,move,frames,fps,sprite}`; `sprite` is relative to
  `viewer/pixel/things/`. The viewer contract from studio-world is followed
  exactly: frame width = image.width / frames, idle frame 0, frames:1 for
  singletons.
- Typed pixel subjects carry an inferred/returned move; the same strip fields
  flow through. An optional `KRITZEL_SPRITE_REFERENCE` image is passed to the
  model as style-only reference.

## Real examples (OpenRouter `anthropic/claude-sonnet-4.5`; Claude Code was over its login window/timeout)

| Example | Frames | Strip | Time | Cost | Reference |
|---|---:|---|---:|---:|---|
| Mädchen walk | 4 | `viewer/pixel/things/maedchen.png` 128×32 | 20.68 s | $0.028248 | full FF sheet |
| Drache fly | 3 | `viewer/pixel/things/drache.png` 96×32 | 20.89 s | $0.030468 | none (full sheet produced a mushroom-winged humanoid; no-reference version kept) |
| Giraffe walk | 4 | `viewer/pixel/things/giraffe.png` 128×48 | 26.13 s | $0.032859 | focused quadruped crop |

The matching `.px.js` sources and ignored preview JSONs are beside the strips.
The exact prompt/reply/model/cost/grids for each are in
`frames/generated/<base>.sprite.json`.

Preview sheets/GIFs:

- walker: `frames/generated/maedchen-strip-4x.png`, `-strip-8x.png`,
  `maedchen-4x.gif`, `maedchen-8x.gif`
- flyer: `frames/generated/drache-strip-4x.png`, `-strip-8x.png`,
  `drache-4x.gif`, `drache-8x.gif`
- giraffe: `frames/generated/giraffe-strip-4x.png`, `-strip-8x.png`,
  `giraffe-4x.gif`, `giraffe-8x.gif`
- all three at 4×: `frames/generated/anim-examples-4x.png`
- native-size reference crops vs our strips: `frames/generated/anim-reference-native.png`

## Quality notes (honest)

The FF reference is a high bar and our 32px sprites are simpler. The final
girl and dragon cycles read as whole-frame walk/fly cycles, with faces,
silhouette changes and top-left light. The giraffe is a long-necked quadruped
at 48 high; its two visible legs/frames are the weakest part. The first knight
walker lost its named sword/shield and was replaced by the girl. The full FF
sheet helped the girl but made the dragon a mushroom-winged humanoid, so the
dragon was regenerated without it; the giraffe used a focused quadruped crop.
All three strips passed whole-frame validation and the GIFs show changing
poses, not sliced static art. This is the quality iteration result; further
art direction would be a separate pass.

A post-QA art experiment added a “frame 1 is the master” prompt constraint and
regenerated the dragon and giraffe. It made both worse: the dragon changed
head-gear and body width between frames, and the giraffe's legs lost
separation. Those experiments are preserved as
`frames/generated/drache-pass2.sprite.json` and
`giraffe-pass2.sprite.json`; the better dragon and giraffe strips were restored
and the prompt experiment was not shipped. The next art pass should focus on
keeping the dragon silhouette stable and giving the giraffe readable
four-legged articulation at the Final Fantasy bar.

The QA finding was fixed by removing generation's duplicate substring
classifier and reusing `viewer/pixel/motion.js`'s tokenized `moverFor` and
`MOVERS`. Regression coverage includes walking, chair, coffee, moon phase,
giraffe, fish, bird, rabbit and spider; explicit `crawl` is covered as `walk`.

## Verification

- Movement fix: `aaf4645` (`fix(pixel): share movement inference with viewer`).
- `cd generate && npm test`: **155 pass, 0 fail**. Includes frame parsing,
  identical-frame rejection, a real 4-frame strip (128×32, palette-only,
  byte-identical repeat), one-fix/no-partial tests, mode JSON `frames/fps/move`,
  atomic typed splits, the sprite mode guard, and whole-word/stem move
  regressions for walking, chair, coffee, moon phase, giraffe, fish, bird,
  rabbit and spider.
- `python3 -m unittest scripts.test_text_thing scripts.test_think`: **28 pass**.
- Viewer status/sounds/thingsounds/carry/pixel-motion tests: **22 pass**.
- `node --check`, `git diff --check`: clean.

## What I did not run

- Live 8765/camera; no full viewer strip playback. The GIFs demonstrate the
  frames; studio-world's whole-frame renderer (`04c70bc`) is the integration
  consumer.
- Claude Code's own model for the examples (its 90s call timed out / was over
  the login window); OpenRouter Claude produced the real strips without a key
  ever being printed.
