# Backlog

Ideas and feature requests that aren't scoped work yet. The kritzel-development
team's lead triages these into missions/slices when there's room; nothing here
is a commitment or a priority order.

- **Camera selection (local + network).** Let the user choose which camera feeds
  the viewer, instead of the hardcoded `/dev/video2` default in
  `scripts/start.sh`. Should cover both local `/dev/video*` devices and cameras
  reachable over the network (e.g. discoverable via Tailscale), not just local
  ones. Raised by Sebastian via advisor-lead@kernel on 2026-10-15. Not blocking
  the initial pipeline build; natural home is wherever the capture-side work
  ends up (capture-build, as of this writing).

## Making it fun for children (Sebastian, 2026-10-15: "it should be really really fun for children")

Ordered by fun per effort; the first five are being started right away.

- **The moment a drawing comes alive.** It pops onto the island with a bounce, a
  puff of paper confetti and a "plopp", and its name appears big for a moment
  ("Ein Vogel!"). Neighbours turn round and run over to look ("Oh, wer bist du?").
- **Draw in colour.** Crayon and felt-tip colours on the paper become the thing's
  colours, instead of the model picking its own.
- **Animals act like animals.** Birds fly in circles and land, fish swim in drawn
  water, spiders climb and spin a web, snails are slow, rabbits hop. This means a few
  movement styles in the sim that generated things can choose from.
- **Tap to play.** Tapping a character makes it jump, giggle and say hello.
  Tapping a thing makes it wiggle (a tree drops an apple, a lamp blinks).
  Following a character with the camera stays on a long press.
- **Weather you can draw.** A rain cloud brings rain (and puddles), snowflakes
  bring snow, a rainbow makes everyone cheer, lightning makes them run for cover.
- **Child-safe speech.** Everything a generated character says stays friendly and
  age-appropriate (part of the generate prompt and its checks).
- **Their own names.** A name written next to a character becomes what the others
  call it ("Hallo, Mia!"), using the word rule.
- **A gallery of worlds.** Every archived sheet becomes a little island in a gallery
  page, so kids can go back and visit yesterday's world.
- **A postcard button.** Saves a nice picture of the world right now (and later
  perhaps prints it).
- **Day and night by itself.** Optionally the sun goes down slowly on its own, and the
  characters go to sleep in their houses.
- **Bigger touch targets.** The viewer works on a tablet next to the paper.
- **Jev's skip rule vs. colouring in (QA, 2026-10-19).** Capture skips a frame when Jev is
  confidently "unchanged", but a pure colouring-in change reads unchanged (0.77) with
  coloured-in at 0.04 (pair 20261015-223105). Today the pixel detector sees no diff there, so
  the skip has not fired. Before trusting it, either exclude frames whose pixels changed inside
  an existing drawing, or require two consecutive confident "unchanged" answers.

## Playtest 2026-10-19 (simulated seven-year-old, camera off)

What the child hit in `viewer/` on 8765 between 19:45 and 20:05 UTC; screenshots in
`.playtest/`. Findings, not commitments — triage when there is room.

- **Nothing to do on an empty world.** "Leg los mit dem Malen!" with no camera and no hint left
  the child clicking everywhere; it found nothing. An empty book needs one obvious next action.
- **The camera error reads like the child broke something.** The picker lists `avd` and
  `apple-isp`; both say "sendet kein Bild", and the stored camera shows a red error box that
  stays open. (The IPEVO was genuinely absent from the Mac's camera server, but the message is
  what a child reads.)
- **Add/Switch is a two-state button with no visible effect offline.** "Hinzufügen" only flips
  the label to "Wechseln" and back; nothing says what changed.
- **A typed thing takes ~45 s.** "ein Drache" showed "Hmm, was ist das wohl?" with a growing
  counter for 13 s and appeared at ~45 s. The measured model times (new: Sonnet 9–10 s,
  DeepSeek 9–11 s) are the floor; the gap is the wait a child actually sits through.
- **Reloading a 40-thing world pops in over a minute.** Empty at 4 s, partly there at 24 s,
  the rest after >60 s. Worth finding out whether that is serve.py, module loading or the
  sim's first frames.
- **Tapping is inconsistent.** The witch answered a long press ("Hallo du draussen!"); clicking
  the penguin and long-pressing the tree did nothing. The child cannot tell which figures are
  alive.
- **The status card never goes away.** "Hexe: fröhlich, steht da" stays above the text field
  with no close affordance, over the place the child types.
- **"Neue Welt" confirms, then shows nothing.** After the second tap there is no waiting/done
  feedback and the old world still fills the screen, so the child thinks the tap failed.
- **The version link opens an English wall of text.** "Kritzel v0.7.0" opens the technical
  changelog; a child (and most parents) cannot use it.
- **Generation can bury the requested thing.** "eine Laterne" left a pile of furniture
  (cupboard, buckets, shelves, lamps) with no obvious lantern; the child could not find its
  thing among the clutter.
