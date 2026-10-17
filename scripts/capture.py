"""Capture stage: watch the chosen camera, hand each finished drawing to the generate stage.

    python3 scripts/capture.py            # needs viewer/serve.py running (it proxies the camera)

Reads camera.json (written by the viewer's camera picker; only kind=remote for now), watches
that camera's small preview stream through the viewer's server (FPS thumbnails a second, decoded
by one ffmpeg) and waits for the picture to settle; the full-size frame it hands on is a snapshot.
When the settled sheet differs from the last one handed on, it writes

    frames/settled/<YYYYmmdd-HHMMSS>.json   first: {captured_at, camera, previous, reason,
                                                     changed, changed_box: [x, y, w, h] px}
    frames/settled/<YYYYmmdd-HHMMSS>.jpg    then, atomically: the camera's JPEG as it came

No frame while something moves (a drawing hand), none when nothing changed. A small change
counts once still for STILL_S ("drawn"); a large one (new sheet, moved paper, a resting hand)
must stay still for BIG_S ("big-change"), or only SHEET_S when the change is scattered all over
the sheet, as a new sheet's is (a hand, its shadow or one big coloured area is one patch). For a drawing, the snapshot is fetched and checked
while the still time runs (from EARLY_S on), so it's handed on as soon as STILL_S is up.

For the viewer's status pill it keeps frames/status/capture.json up to date (state, since, beat,
detail, last) and writes frames/status/cutout.png for each drawing handed on: the new ink on
white paper, cut out around it. Needs ffmpeg. Env: VIEWER (default
http://127.0.0.1:8765), KRITZEL_ROOT (where camera.json and frames/ live).
"""
import datetime
import math
import json
import os
import re
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("KRITZEL_ROOT", Path(__file__).resolve().parent.parent))
OUT = ROOT / "frames" / "settled"
STATUS = ROOT / "frames" / "status"
VIEWER = os.environ.get("VIEWER", "http://127.0.0.1:8765")
W, H = 320, 180          # compare at this size: averages away sensor noise, keeps pencil lines
PIXEL = 20               # brightness step (0-255) that counts as a changed pixel
NEW_PX = 15              # changed pixels that count: vs the still picture = movement, vs the last sheet = new
INK_R = 2                # new ink must be this far (thumb px) from ink already there
SLIDE = 8                # how far (thumb px, ×6 at 1080p) the paper may slide and still be the same sheet
INK_EDGE, INK_SHARE = 25, 0.25   # local contrast that is ink, not shade; share of a change that must be inky
SHEET_INK = 600            # NEW inky thumb px that make a big change a new sheet with a drawing, whatever the share
EDGE = 10                # thumb px at the frame's edge that never count (the table shows there when the paper slides)
BIG = 0.04               # share changed that is a big change, not drawing
STILL_S, BIG_S, FPS = 1.2, 8.0, 8
TURN, REACH = 6, 40      # a sheet turned up to TURN degrees and slid up to REACH thumb px (×6 at 1080p) is still the same sheet
SHEET_S, SCATTER, SPAN = 3.0, 0.6, 0.5   # a big change whose biggest patch is under SCATTER of it, spanning over
                                        # SPAN of the picture: a new sheet, handed on after SHEET_S
EARLY_S = 0.3            # into a still spell: look what's new, and fetch the snapshot of a drawing already
SHRINK = f"format=gray,scale=960:540:flags=area,erosion,erosion,scale={W}:{H}:flags=area"   # keeps thin lines
MAX_BYTES = 20 << 20


def jpeg_size(data):
    """(width, height) from a JPEG's SOF header, or None if it isn't a sane JPEG."""
    if not data.startswith(b"\xff\xd8") or len(data) > MAX_BYTES:
        return None
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            return None
        marker, seglen = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = int.from_bytes(data[i + 5:i + 7], "big"), int.from_bytes(data[i + 7:i + 9], "big")
            return (w, h) if 64 <= w <= 8192 and 64 <= h <= 8192 else None
        i += 2 + seglen
    return None


def centred(px):
    """Brightness centred on the median, so exposure drift is no change."""
    m = statistics.median(px[::7])
    return [p - m for p in px]


def small(data):
    """Grey W×H thumbnail of one JPEG."""
    try:
        px = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "jpeg_pipe", "-i", "-", "-vf", SHRINK,
                             "-f", "rawvideo", "-"], input=data, capture_output=True, timeout=10).stdout
    except (subprocess.SubprocessError, OSError) as e:
        print(f"ffmpeg: {e}", file=sys.stderr, flush=True)
        return None
    return centred(px) if len(px) == W * H else None


class Stream:
    """One ffmpeg turning the camera's MJPEG stream into thumbnails; keeps only the newest, so a
    slow moment never builds a backlog."""

    def __init__(self, url):
        self.frame, self.seq, self.error, self.cond = None, 0, "", threading.Condition()
        try:
            self.proc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-f", "mpjpeg", "-i", url, "-vf",
                                          f"fps={FPS},{SHRINK}", "-f", "rawvideo", "-"],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            self.proc, self.error = None, str(e)
            return
        self.last_err, self.at = "", time.monotonic()
        threading.Thread(target=self.read, daemon=True).start()
        threading.Thread(target=self.log, daemon=True).start()

    def log(self):                   # drained all the time, or a full pipe would stall ffmpeg
        for line in self.proc.stderr:
            self.last_err = line.decode(errors="replace").strip() or self.last_err

    def read(self):
        while len(px := self.proc.stdout.read(W * H)) == W * H:
            with self.cond:
                self.frame, self.seq, self.at = px, self.seq + 1, time.monotonic()
                self.cond.notify_all()
        self.proc.wait()
        with self.cond:
            self.error = self.last_err or "stream ended"
            self.cond.notify_all()

    def next(self, seq, timeout=2):
        """The newest thumbnail after `seq`, as (pixels, seq); (None, seq) on timeout or end."""
        with self.cond:
            self.cond.wait_for(lambda: self.seq != seq or self.error, timeout)
            return (self.frame, self.seq) if self.seq != seq else (None, seq)

    def stop(self):
        if self.proc:
            self.proc.kill()
            self.proc.wait()


def envelope(thumb, ink=INK_R):
    """Darkest value within `ink` px and brightest within 1 px of each pixel, so lines already
    on the sheet that moved a little (camera wobble, paper slightly turned) don't look new."""
    def pool(f, r):
        n = 2 * r + 1
        rows = []
        for y in range(H):
            row = thumb[y * W:(y + 1) * W]
            row = [row[0]] * r + row + [row[-1]] * r
            rows.append(list(map(f, *(row[k:k + W] for k in range(n)))))
        rows = [rows[0]] * r + rows + [rows[-1]] * r
        return [v for group in zip(*(rows[k:k + H] for k in range(n))) for v in map(f, *group)]
    return pool(min, ink), pool(max, 1)


def new_marks(thumb, env):
    """Pixels that changed, without lone specks and without the frame's outer edge (where the
    table shows when the paper slides)."""
    hit = {i for i, (x, lo, hi) in enumerate(zip(thumb, *env)) if x < lo - PIXEL or x > hi + PIXEL}
    m = EDGE
    return [i for i in sorted(hit) if m <= i % W < W - m and m <= i // W < H - m
            and sum(j in hit for j in (i - 1, i + 1, i - W, i + W, i - W - 1, i - W + 1, i + W - 1, i + W + 1)) >= 2]


def inky(marks, aligned, baseline):
    """Only changes with ink in them: pixels with a sharp edge nearby, in the new picture (ink
    drawn) or the old (ink erased). A shadow or light that moved is a soft gradient: if the inky
    part is only a small share of the change, nothing was drawn."""
    lo, hi = envelope(aligned, 1)
    blo, bhi = baseline
    ink = [i for i in marks if hi[i] - lo[i] >= INK_EDGE or bhi[i] - blo[i] >= INK_EDGE]
    if len(ink) >= INK_SHARE * len(marks):
        return ink
    # a whole new sheet changes mostly smooth paper, so its ink share is low; plenty of ink in
    # absolute terms on a big change is a new sheet with a drawing on it, not a moving shadow
    if len(marks) >= BIG * W * H:
        # only ink that is new: a big shadow over an existing drawing changes the old lines too
        new_ink = sum(1 for i in marks if hi[i] - lo[i] >= INK_EDGE and bhi[i] - blo[i] < INK_EDGE)
        if new_ink >= SHEET_INK:
            return marks
    return []


def paper_shift(thumb, base):
    """How far (dx, dy) the sheet slid since `base`: the offset that fits best, up to SLIDE px."""
    pts = [(x, y) for y in range(SLIDE, H - SLIDE, 3) for x in range(SLIDE, W - SLIDE, 3)]
    cost = lambda d: sum(abs(thumb[(y + d[1]) * W + x + d[0]] - base[y * W + x]) for x, y in pts)
    return min(((dx, dy) for dy in range(-SLIDE, SLIDE + 1) for dx in range(-SLIDE, SLIDE + 1)),
               key=lambda d: (cost(d), abs(d[0]) + abs(d[1])))


def moved(thumb, d):
    """`thumb` slid back by d, so it lines up with the picture it was compared with."""
    dx, dy = d
    out = []
    for y in range(H):
        r = min(max(y + dy, 0), H - 1) * W
        row = thumb[r:r + W]
        out += row[dx:] + row[-1:] * dx if dx >= 0 else row[:1] * -dx + row[:dx]
    return out


def quarter(img):
    """A quarter-size (W/4 × H/4) picture: 4×4 blocks averaged."""
    w, h = W // 4, H // 4
    return [sum(img[(4 * y + j) * W + 4 * x + i] for j in range(4) for i in range(4)) / 16 for y in range(h) for x in range(w)]


def fit(thumb, base):
    """How the sheet turned and slid since `base` when that is more than paper_shift can follow:
    (degrees, dx, dy) with thumb at R(p - centre) + centre + d ≈ base at p. Searched coarsely on
    quarter-size pictures, then refined at full size. Pure Python, about a second: only for big changes."""
    def search(img, ref, w, h, step, angles, offsets):
        # room around the picture for every candidate: the slide, plus how far a turn of up to TURN degrees
        # moves the corners (live 2026-10-17 15:47: without the turn's share the index ran off the list)
        pad = REACH // (W // w) + 8 + math.ceil(2 * math.sin(math.radians(TURN + 1) / 2) * math.hypot(w, h) / 2) + 2
        pw = w + 2 * pad
        padded = [0.0] * (pw * (h + 2 * pad))           # 0 = the picture's median brightness
        for y in range(h):
            padded[(y + pad) * pw + pad:(y + pad) * pw + pad + w] = img[y * w:(y + 1) * w]
        cx, cy, best = (w - 1) / 2, (h - 1) / 2, None
        pts = [(x, y) for y in range(0, h, step) for x in range(0, w, step)]
        vals = [ref[y * w + x] for x, y in pts]
        for a in angles:
            ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
            idx = [(round(sa * (x - cx) + ca * (y - cy) + cy) + pad) * pw + round(ca * (x - cx) - sa * (y - cy) + cx) + pad
                   for x, y in pts]
            for dx, dy in offsets:
                o = dy * pw + dx
                cost = sum(abs(padded[i + o] - v) for i, v in zip(idx, vals))
                if best is None or cost < best[0]:
                    best = (cost, a, dx, dy)
        return best
    r = REACH // 4
    _, a, dx, dy = search(quarter(thumb), quarter(base), W // 4, H // 4, 3, range(-TURN, TURN + 1),
                          [(x, y) for y in range(-r, r + 1) for x in range(-r, r + 1)])
    _, a, dx, dy = search(thumb, base, W, H, 6, [a + k / 4 for k in range(-3, 4)],
                          [(4 * dx + x, 4 * dy + y) for y in range(-3, 4) for x in range(-3, 4)])
    return a, dx, dy


def warp(thumb, a, d):
    """`thumb` lined up with the picture it was compared with, after the sheet turned by a degrees
    and slid by d (as fit() measured it): every pixel p takes thumb's value at R(p - centre) + centre + d."""
    ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
    cx, cy, out = (W - 1) / 2, (H - 1) / 2, []
    for y in range(H):
        for x in range(W):
            X = min(max(round(ca * (x - cx) - sa * (y - cy) + cx + d[0]), 0), W - 1)
            Y = min(max(round(sa * (x - cx) + ca * (y - cy) + cy + d[1]), 0), H - 1)
            out.append(thumb[Y * W + X])
    return out


class Detector:
    """Feed it snapshots; it returns (reason, changed_indices) when a new sheet has settled.

    Stillness is measured against the picture at the start of the still spell (the anchor),
    not the previous sample, so slow drawing or a creeping shadow also restarts the wait.
    Before comparing with the last sheet handed on, the picture is lined up with it, so paper
    that slid a little isn't news."""

    def __init__(self, baseline=None):
        self.base = baseline
        self.baseline = baseline and envelope(baseline)
        self.anchor = self.still_since = self.shift = self.moved_at = self.diff = self.measured = None
        self.turn, self.fitted = 0, False    # degrees the sheet turned, and whether fit() lined it up
        self.fit_due = False                 # a big change in this still spell that fit() should try
        self.spell = 0                       # counts still spells
        self.patchy = None                   # (diff, scattered?) for the diff it was worked out for

    def feed(self, thumb, t):
        if self.anchor is None or len(new_marks(thumb, self.anchor)) >= NEW_PX:
            if self.anchor is not None:
                self.moved_at = t
            self.anchor, self.still_since, self.shift, self.diff, self.turn = envelope(thumb, 1), t, None, None, 0
            self.fitted = False
            self.spell += 1
            return None
        if t - self.still_since < EARLY_S:
            return None
        if self.diff is None:                # once per still spell: what is new since the last sheet?
            if self.baseline is None:
                self.shift, self.diff = (0, 0), list(range(W * H))
            else:
                self.shift = paper_shift(thumb, self.base)
                aligned = moved(thumb, self.shift)
                self.diff = inky(new_marks(aligned, self.baseline), aligned, self.baseline)
                self.fit_due = self.big()     # doesn't line up by sliding: the same sheet turned, or slid further?
        # (fit() takes a second or two: only once the big change has been still for STILL_S, so a hand
        # pausing on the paper doesn't hold up the loop; a sheet waits SHEET_S anyway)
        if self.fit_due and t - self.still_since >= STILL_S:
            self.fit_due = False
            a, dx, dy = fit(thumb, self.base)
            aligned = warp(thumb, a, (dx, dy))
            diff = inky(new_marks(aligned, self.baseline), aligned, self.baseline)
            if len(diff) <= BIG * W * H:
                self.turn, self.shift, self.diff, self.fitted = a, (dx, dy), diff, True
        diff = self.diff
        if len(diff) < NEW_PX:
            return None
        big = self.big()
        if t - self.still_since < (STILL_S if not big else SHEET_S if self.scattered() else BIG_S):
            return None
        dx, dy = self.shift
        # how the sheet moved since the last one handed on (degrees, thumb px), if that could be measured:
        # not for the first sheet, not for a new sheet, not when the best slide sits at the search's edge
        self.measured = None if (self.baseline is None or (not self.fitted and max(abs(dx), abs(dy)) >= SLIDE)
                                 or len(diff) > 0.5 * W * H) else (self.turn, dx, dy)
        # where the change is in the new picture
        ca, sa = math.cos(math.radians(self.turn)), math.sin(math.radians(self.turn))
        cx, cy = (W - 1) / 2, (H - 1) / 2
        diff = [min(max(round(sa * (i % W - cx) + ca * (i // W - cy) + cy + dy), 0), H - 1) * W
                + min(max(round(ca * (i % W - cx) - sa * (i // W - cy) + cx + dx), 0), W - 1) for i in diff]
        self.prev = (self.base, self.baseline)
        self.base, self.baseline, self.still_since, self.shift, self.diff, self.turn = thumb, envelope(thumb), t, (0, 0), [], 0
        self.fitted = False
        return ("big-change" if big else "drawn"), diff

    def scattered(self):
        """The change is spread over many patches, the biggest under SCATTER of it, and over most of the
        picture (its bounding box over SPAN of it): a new sheet (its lines and paper edges changed
        everywhere), not a hand, an arm or a shadow lying on the paper. Once per still spell."""
        if self.patchy is None or self.patchy[0] is not self.diff:
            xs, ys = [i % W for i in self.diff], [i // W for i in self.diff]
            if (max(xs) - min(xs)) * (max(ys) - min(ys)) < SPAN * W * H:
                self.patchy = self.diff, False
                return False
            left, biggest = set(self.diff), 0
            while left and biggest < SCATTER * len(self.diff):
                todo, n = [left.pop()], 1
                while todo:
                    i = todo.pop()
                    for j in (i - 1, i + 1, i - W, i + W, i - W - 1, i - W + 1, i + W - 1, i + W + 1):
                        if j in left:
                            left.remove(j)
                            todo.append(j)
                            n += 1
                biggest = max(biggest, n)
            self.patchy = self.diff, biggest < SCATTER * len(self.diff)
        return self.patchy[1]

    def big(self):
        """A large change, or a sheet that slid further than we can line up."""
        return len(self.diff) > BIG * W * H or (self.baseline is not None and not self.fitted and max(map(abs, self.shift)) >= SLIDE)

    def drawing(self):
        """Still for EARLY_S with a small change in it: a drawing that will be handed on at STILL_S
        unless something moves first (this still spell's number), else None."""
        return self.spell if self.diff and len(self.diff) >= NEW_PX and not self.big() else None

    def undo(self, t):
        """The last emit didn't happen after all: back to the sheet before it, wait for stillness again."""
        self.base, self.baseline = self.prev
        self.anchor, self.still_since, self.shift, self.diff, self.turn, self.fitted = None, t, None, None, 0, False


def box(diff, size):
    """Where the change is, in picture px, padded by 2 thumb px. For a drawing, only clumps of
    marks at least a tenth the size of the biggest count, so stray specks don't stretch it."""
    keep = diff
    if len(diff) <= 3000:
        left, clumps = set(diff), []
        while left:
            todo = [left.pop()]
            clump = list(todo)
            while todo:
                i = todo.pop()
                for dy in range(-3, 4):
                    for dx in range(-3, 4):
                        j = i + dy * W + dx
                        if j in left and abs(j % W - i % W) <= 3:
                            left.remove(j)
                            todo.append(j)
                            clump.append(j)
            clumps.append(clump)
        big = max(map(len, clumps))
        keep = [i for c in clumps if len(c) * 10 >= big for i in c]
    xs, ys = [i % W for i in keep], [i // W for i in keep]
    x0, x1, y0, y1 = max(min(xs) - 2, 0), min(max(xs) + 3, W), max(min(ys) - 2, 0), min(max(ys) + 3, H)
    sx, sy = size[0] / W, size[1] / H
    return [int(x0 * sx), int(y0 * sy), int(x1 * sx) - int(x0 * sx), int(y1 * sy) - int(y0 * sy)]


def camera():
    """The chosen remote camera as (snapshot URL, info), or None."""
    try:
        c = json.loads((ROOT / "camera.json").read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(c, dict) or c.get("kind") != "remote":
        return None
    ip, cam = str(c.get("ip", "")), str(c.get("id", ""))
    if not re.fullmatch(r"[\d.]+", ip) or not re.fullmatch(r"video\d+", cam):
        return None
    return (f"{VIEWER}/api/camera-stream/{ip}/{cam}.jpg",
            {"host": str(c.get("host", ""))[:100], "id": cam, "name": str(c.get("name", ""))[:200]})


class Snapshot:
    """The full-size picture, fetched (and shrunk for the check) in the background."""

    def __init__(self, url, spell):
        self.spell, self.result = spell, None
        self.thread = threading.Thread(target=self.fetch, args=(url,), daemon=True)
        self.thread.start()

    def fetch(self, url):
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                data = r.read(MAX_BYTES + 1)
        except Exception as e:               # OSError, or http.client's IncompleteRead and the like
            self.result = e if isinstance(e, OSError) else OSError(str(e) or type(e).__name__)
            return
        size = jpeg_size(data)
        self.result = data, size, size and small(data)

    def get(self):
        """(data, size, thumbnail or None), or raises the fetch's OSError."""
        self.thread.join()
        if isinstance(self.result, OSError):
            raise self.result
        return self.result


def affine(moved_by, size):
    """(degrees, dx, dy) in thumb px, as the Detector measured it → [a, b, c, d, e, f] in picture px."""
    deg, dx, dy = moved_by
    sx, sy = size[0] / W, size[1] / H
    ca, sa = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    cx, cy = (W - 1) / 2 * sx, (H - 1) / 2 * sy
    r = lambda v, n=1: round(v, n) + 0.0
    return [r(ca, 4), r(-sa, 4), r(cx - ca * cx + sa * cy + dx * sx), r(sa, 4), r(ca, 4), r(cy - sa * cx - ca * cy + dy * sy)]


def hand_on(data, size, reason, diff, info, previous, moved_by=None):
    now = datetime.datetime.now()
    stem = now.strftime("%Y%m%d-%H%M%S")
    meta = {"captured_at": now.astimezone().isoformat(timespec="seconds"), "camera": info,
            "previous": previous, "reason": reason, "changed": round(len(diff) / (W * H), 4),
            "changed_box": box(diff, size), "width": size[0], "height": size[1],
            # previous frame's px → this frame's px (x' = a*x + b*y + c, y' = d*x + e*y + f): a slide, or
            # a turn (up to TURN°) and slide (up to REACH thumb px); null when it could not be measured
            "affine": moved_by and affine(moved_by, size)}
    for name, body in ((f"{stem}.json", json.dumps(meta, indent=2).encode() + b"\n"), (f"{stem}.jpg", data)):
        tmp = OUT / (name + ".tmp")
        tmp.write_bytes(body)
        tmp.replace(OUT / name)
    print(f"{stem}: {reason}, {meta['changed']:.1%} changed, box {meta['changed_box']}", flush=True)
    return f"{stem}.jpg"


def write_atomic(path, body):
    tmp = path.with_name("." + path.name + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(path)


class Status:
    """frames/status/capture.json: what capture is doing now, rewritten at least every 2 s
    (beat) so the viewer can tell a running capture from a dead one."""

    def __init__(self):
        self.state, self.since, self.written, self.last = None, 0, 0, None

    def set(self, state, detail=""):
        now = time.time()
        if state != self.state:
            self.state, self.since = state, now
        elif now - self.written < 2:
            return
        self.written = now
        try:
            STATUS.mkdir(parents=True, exist_ok=True)
            write_atomic(STATUS / "capture.json", json.dumps({"state": state, "since": self.since, "beat": now,
                                                              "detail": detail, "last": self.last}).encode())
        except OSError as e:
            print(f"status: {e}", file=sys.stderr, flush=True)


def dilate(mask, w, h, r):
    """Boolean mask grown by r px (a square), rows then columns."""
    def grow(line):
        n, acc, out = len(line), [0], []
        for v in line:
            acc.append(acc[-1] + v)
        return [acc[min(n, i + r + 1)] - acc[max(0, i - r)] > 0 for i in range(n)]
    rows = [grow(mask[y * w:(y + 1) * w]) for y in range(h)]
    cols = [grow([rows[y][x] for y in range(h)]) for x in range(w)]
    return [cols[x][y] for y in range(h) for x in range(w)]


def cutout(data, box_px, size, path, diff=None, side=256):
    """The changed area as a paper cut-out: dark ink on white, transparent outside a margin
    around the ink. Same margin as generate's crop. With `diff` (the new marks, thumb pixels)
    only ink near them counts, so older drawings in the margin stay out."""
    x, y, w, h = box_px
    m = max(40, int(0.15 * max(w, h)))
    x0, y0 = max(0, x - m), max(0, y - m)
    x1, y1 = min(size[0], x + w + m), min(size[1], y + h + m)
    k = min(1, side / max(x1 - x0, y1 - y0))
    ow, oh = max(1, round((x1 - x0) * k)), max(1, round((y1 - y0) * k))
    px = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "jpeg_pipe", "-i", "-", "-vf",
                         f"crop={x1 - x0}:{y1 - y0}:{x0}:{y0},scale={ow}:{oh}:flags=area,format=gray",
                         "-f", "rawvideo", "-"], input=data, capture_output=True, timeout=10).stdout
    if len(px) != ow * oh:
        return False
    paper = max(1, sorted(px)[len(px) * 4 // 5])          # most of the crop is paper
    ink = [min(1, max(0, ((paper - v) / paper - 0.15) / 0.25)) for v in px]
    if diff:
        near = set()
        for i in diff:
            for dy in (-2, -1, 0, 1, 2):
                for dx in (-2, -1, 0, 1, 2):
                    near.add(i + dy * W + dx)
        sx, sy = size[0] / W, size[1] / H
        ink = [a if (int((y0 + (j // ow + 0.5) / k) / sy) * W + int((x0 + (j % ow + 0.5) / k) / sx)) in near else 0
               for j, a in enumerate(ink)]
    keep = dilate([a > 0.3 for a in ink], ow, oh, max(4, ow // 28))
    if not any(keep):
        return False
    xs, ys = [j % ow for j, v in enumerate(keep) if v], [j // ow for j, v in enumerate(keep) if v]
    bx0, bx1, by0, by1 = min(xs), max(xs) + 1, min(ys), max(ys) + 1    # trimmed to the cut-out itself
    rgba = bytearray()
    for y in range(by0, by1):
        for j in range(y * ow + bx0, y * ow + bx1):
            c = round(255 - ink[j] * (255 - 38))
            rgba += bytes((c, round(c * 0.97), round(c * 0.93), 255 if keep[j] else 0))
    ow, oh = bx1 - bx0, by1 - by0
    png = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{ow}x{oh}",
                          "-i", "-", "-f", "image2", "-c:v", "png", "-"], input=bytes(rgba), capture_output=True,
                         timeout=10).stdout
    if not png:
        return False
    write_atomic(path, png)
    return True


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    done = sorted(OUT.glob("*.jpg"))
    previous = done[-1].name if done else None
    det = Detector(small(done[-1].read_bytes()) if done else None)
    status, stream, url, seq, checked, cam, early = Status(), None, None, 0, 0, None, None
    while True:
        if time.monotonic() - checked > 1:   # the picker may switch cameras at any time
            checked, cam = time.monotonic(), camera()
            if cam is None or cam[0] != url:
                if stream:
                    stream.stop()
                stream, url, seq, det.anchor = None, cam and cam[0], 0, None
        if cam is None:                       # none chosen (or no camera.json): wait, and say so
            status.set("no-camera")
            time.sleep(0.5)
            continue
        if stream is None:
            print(f"watching {cam[1]['name']} on {cam[1]['host']}", flush=True)
            url = cam[0]
            stream = Stream(url[:-4] + ".mjpg?small")   # the 960 px preview is enough to watch
        px, seq = stream.next(seq)
        if px is None:
            if stream.error:
                print(f"camera: {stream.error}", file=sys.stderr, flush=True)
                status.set("camera-off", stream.error[:120])
                stream.stop()
                stream, url = None, None      # reconnect after a pause
                time.sleep(2)
            elif time.monotonic() - stream.at > 4:
                status.set("camera-off", "kein Bild seit %d s" % (time.monotonic() - stream.at))
            else:
                status.set(status.state or "watching")   # keep the heartbeat going
            continue
        t = time.monotonic()
        got = det.feed(centred(px), t)
        spell = det.drawing()
        if spell and (early is None or early.spell != spell):
            early = Snapshot(url, spell)      # a drawing, still for EARLY_S: fetch it while the still time runs
        if not got:
            status.set("moving" if det.moved_at and t - det.moved_at < STILL_S + 1 else "watching")
            continue
        # hand on the full-size picture, not the thumbnail: the one fetched early in this still
        # spell, or (a big change, or the stream moved on) one fetched now
        shot = early if early and early.spell == det.spell and got[0] == "drawn" else Snapshot(url, None)
        early = None
        try:
            data, size, snap = shot.get()
        except OSError as e:
            print(f"camera snapshot: {e}", file=sys.stderr, flush=True)
            det.undo(t)                       # don't lose the drawing: let it settle and try again
            continue
        if not snap or len(new_marks(snap, det.anchor)) >= NEW_PX:
            # the snapshot isn't the picture that settled (a hand came back): let it settle again
            print("snapshot differs from the settled picture; waiting again", file=sys.stderr, flush=True)
            det.undo(t)
            continue
        previous = hand_on(data, size, *got, cam[1], previous, det.measured if previous else None)
        meta = json.loads((OUT / previous.replace(".jpg", ".json")).read_text())
        try:
            cut = cutout(data, meta["changed_box"], size, STATUS / "cutout.png", got[1])
        except (subprocess.SubprocessError, OSError):
            cut = False
        status.last = {"frame": previous[:-4], "at": time.time(), "reason": got[0], "box": meta["changed_box"],
                       "width": size[0], "height": size[1], "cutout": cut}
        status.set("settled", previous[:-4])

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
