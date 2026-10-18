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
counts once still for STILL_S ("drawn"); a large one (new sheet, moved paper)
must stay still for BIG_S ("big-change"), or only SHEET_S when the change is scattered all over
the sheet or fills the picture, as a new sheet's is (a hand, its shadow or one big coloured area
is one patch). For a drawing, the snapshot is fetched and checked while the still time runs (from
EARLY_S on), so it's handed on as soon as STILL_S is up.
A hand resting on the sheet (or a table with no paper) keeps the frame waiting, and says so in
the status; the sheet is handed on only once the hand is gone.

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

try:                     # lining up a moved sheet takes milliseconds with numpy, seconds without
    import numpy as np
except ImportError:
    np = None

ROOT = Path(os.environ.get("KRITZEL_ROOT", Path(__file__).resolve().parent.parent))
OUT = ROOT / "frames" / "settled"
STATUS = ROOT / "frames" / "status"
VIEWER = os.environ.get("VIEWER", "http://127.0.0.1:8765")
W, H = 320, 180          # compare at this size: averages away sensor noise, keeps pencil lines
PIXEL = 20               # brightness step (0-255) that counts as a changed pixel
NEW_PX = 15              # changed pixels that count: vs the still picture = movement, vs the last sheet = new
SNAP_DIFF = 200          # a full snapshot this far from the preview is another picture, not resampling
INK_R = 2                # new ink must be this far (thumb px) from ink already there
SLIDE = 8                # how far (thumb px, ×6 at 1080p) the paper may slide and still be the same sheet
INK_EDGE, INK_SHARE = 25, 0.25   # local contrast that is ink, not shade; share of a change that must be inky
SHEET_INK = 600            # NEW inky thumb px that make a big change a new sheet with a drawing, whatever the share
EDGE = 10                # thumb px at the frame's edge that never count (the table shows there when the paper slides)
BIG = 0.04               # share changed that is a big change, not drawing
STILL_S, BIG_S, FPS = 1.2, 8.0, 8
TURN, REACH = 6, 40      # a sheet turned up to TURN degrees and slid up to REACH thumb px (×6 at 1080p) is still the same sheet
OVERLAP, MATCH = 0.15, 0.6   # ...and one slid further, partly out of view: OVERLAP of the picture still shows where it
                             # was, and its lines and the new picture's match there (MATCH: shared / either)
SHEET_S, SCATTER, SPAN = 3.0, 0.6, 0.5   # a big change whose biggest patch is under SCATTER of it, spanning over
                                        # SPAN of the picture: a new sheet, handed on after SHEET_S
EARLY_S = 0.3            # into a still spell: look what's new, and fetch the snapshot of a drawing already
SHRINK = f"format=gray,scale=960:540:flags=area,erosion,erosion,scale={W}:{H}:flags=area"   # keeps thin lines
CW, CH = 96, 54          # colour thumbnail: the sheet and a hand, not the drawing's lines
PAPER_BLOCK = 4          # one flatness sample is this many colour-thumbnail px square
FLAT = 7                 # largest per-channel spread inside a block that is paper-flat (0-255)
COLOUR_DIFF = 26         # neighbouring flat blocks this close are the same sheet, not paper beside a hand
PAPER_SHARE, PAPER_FILL = 0.10, 0.25   # a sheet covers this much of the picture, and this much of its box
HAND_SHARE, HAND_ON_PAPER = 0.008, 0.15   # a skin blob this large, with this share of it on the sheet
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


def colour(data):
    """Small RGB thumbnail of one JPEG: [r, g, b, r, g, b, ...], or None."""
    try:
        px = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "jpeg_pipe", "-i", "-", "-vf",
                             f"scale={CW}:{CH}:flags=area,format=rgb24", "-f", "rawvideo", "-"],
                            input=data, capture_output=True, timeout=10).stdout
    except (subprocess.SubprocessError, OSError) as e:
        print(f"ffmpeg: {e}", file=sys.stderr, flush=True)
        return None
    return list(px) if len(px) == CW * CH * 3 else None


def blocks(rgb):
    """(width, height, mean colour per block, whether each block is one flat colour)."""
    bw, bh = CW // PAPER_BLOCK, CH // PAPER_BLOCK
    means, flat = [], []
    for by in range(bh):
        for bx in range(bw):
            sums, squares = [0, 0, 0], [0, 0, 0]
            for y in range(by * PAPER_BLOCK, (by + 1) * PAPER_BLOCK):
                for x in range(bx * PAPER_BLOCK, (bx + 1) * PAPER_BLOCK):
                    i = (y * CW + x) * 3
                    for c in range(3):
                        sums[c] += rgb[i + c]
                        squares[c] += rgb[i + c] * rgb[i + c]
            n = PAPER_BLOCK * PAPER_BLOCK
            mean = [s / n for s in sums]
            means.append(mean)
            flat.append(max(math.sqrt(max(0, squares[c] / n - mean[c] * mean[c])) for c in range(3)) <= FLAT)
    return bw, bh, means, flat


def neighbours(i, w, h):
    """The 8 blocks around block i (row-major in a w × h grid)."""
    x, y = i % w, i // w
    for jy in range(max(0, y - 1), min(h, y + 2)):
        for jx in range(max(0, x - 1), min(w, x + 2)):
            j = jy * w + jx
            if j != i:
                yield j


def paper(rgb):
    """The sheet in a colour thumbnail: {w, h, mask, colour, area}, or None when no paper is there.

    A sheet is the largest connected field of flat, similarly coloured blocks. It may be any
    colour (white, yellow, blue, ...); table grain breaks the field, and a hand is its own colour,
    so neither is taken for paper."""
    if not rgb:
        return None
    bw, bh, means, flat = blocks(rgb)
    seen, parts = set(), []
    for i in range(bw * bh):
        if not flat[i] or i in seen:
            continue
        seen.add(i)
        todo, part = [i], []
        while todo:
            j = todo.pop()
            part.append(j)
            for k in neighbours(j, bw, bh):
                if flat[k] and k not in seen and all(abs(means[j][c] - means[k][c]) <= COLOUR_DIFF for c in range(3)):
                    seen.add(k)
                    todo.append(k)
        parts.append(part)
    best, colour = None, None
    for part in sorted(parts, key=len, reverse=True):
        if len(part) < PAPER_SHARE * bw * bh:
            continue
        xs, ys = [i % bw for i in part], [i // bw for i in part]
        if (max(xs) - min(xs) + 1) < 0.25 * bw or (max(ys) - min(ys) + 1) < 0.25 * bh:
            continue
        if len(part) < PAPER_FILL * (max(xs) - min(xs) + 1) * (max(ys) - min(ys) + 1):
            continue
        col = [statistics.median(means[i][c] for i in part) for c in range(3)]
        if wood(col):
            continue                         # the brown table itself, not a sheet lying on it
        best, colour = part, col
        break
    if best is None:
        return None
    xs, ys = [i % bw for i in best], [i // bw for i in best]
    edge = [i for i in range(bw * bh) if i % bw in (0, bw - 1) or i // bw in (0, bh - 1)]
    woods = [means[i] for i in edge if wood(means[i])]
    table = [statistics.median(c[d] for c in woods) for d in range(3)] if len(woods) >= 3 else None
    mask = [False] * (bw * bh)
    for i in best:
        mask[i] = True
    return {"w": bw, "h": bh, "mask": mask, "colour": colour, "area": len(best) * PAPER_BLOCK * PAPER_BLOCK,
            "box": (min(xs), min(ys), max(xs), max(ys)), "table": table}


def hue(r, g, b):
    """Hue in degrees (0 = red, 60 = yellow) for a colour."""
    mx, mn, d = max(r, g, b), min(r, g, b), max(r, g, b) - min(r, g, b)
    if d == 0:
        return 0
    if mx == r:
        return 60 * ((g - b) / d % 6)
    if mx == g:
        return 60 * (2 + (b - r) / d)
    return 60 * (4 + (r - g) / d)


def wood(colour):
    """Warm brown, like the table: not white, blue or yellow paper."""
    r, g, b = colour
    mx, mn = max(colour), min(colour)
    return 5 <= hue(r, g, b) <= 34 and (mx - mn) >= 0.15 * max(1, mx) and mx >= 40


def skin(r, g, b):
    """A warm red-orange pixel: skin, not grey paper or yellow paper (which is around hue 44)."""
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if mx < 45 or d < max(18, 0.18 * mx) or not (r > g >= b) or (g - b) > 0.5 * (r - b):
        return False
    h = 60 * (g - b) / d                    # r is the largest channel, so hue lies between 0 and 60
    return 2 <= h <= 38


def smooth_rgb(rgb, x, y, r=1, step=24):
    """Whether the 3x3 pixels around (x, y) are one smooth colour: skin, not wood grain."""
    lo, hi = [255, 255, 255], [0, 0, 0]
    for yy in range(max(0, y - r), min(CH, y + r + 1)):
        for xx in range(max(0, x - r), min(CW, x + r + 1)):
            i = (yy * CW + xx) * 3
            for c in range(3):
                lo[c], hi[c] = min(lo[c], rgb[i + c]), max(hi[c], rgb[i + c])
    return max(hi[c] - lo[c] for c in range(3)) <= step


def blobs(mask, w, h):
    """Connected (8-neighbour) fields of True in a w × h mask, as lists of pixel indices."""
    seen, out = set(), []
    for i, on in enumerate(mask):
        if not on or i in seen:
            continue
        seen.add(i)
        todo, part = [i], []
        while todo:
            j = todo.pop()
            part.append(j)
            for k in neighbours(j, w, h):
                if mask[k] and k not in seen:
                    seen.add(k)
                    todo.append(k)
        out.append(part)
    return out


def hand(rgb, sheet, base=None):
    """A skin-coloured blob lying on (or touching the edge of) the sheet.

    With `base` (the last settled picture), most of the blob must be new: the wooden table is
    warm and smooth too, but it was already there. Without a base, the blob's middle must be on
    the sheet, which keeps a table edge out."""
    if not rgb:
        return False
    bw, bh = sheet["w"], sheet["h"]
    near, touch = [False] * (bw * bh), [False] * (bw * bh)
    for i, flat in enumerate(sheet["mask"]):
        if flat:
            for y in range(max(0, i // bw - 2), min(bh, i // bw + 3)):
                for x in range(max(0, i % bw - 2), min(bw, i % bw + 3)):
                    near[y * bw + x] = True
            for y in range(max(0, i // bw - 1), min(bh, i // bw + 2)):
                for x in range(max(0, i % bw - 1), min(bw, i % bw + 2)):
                    touch[y * bw + x] = True
    # only warm pixels around the sheet can be the hand: the wooden table is warm too, but it is
    # not on the sheet and must not join the hand's blob
    at = lambda i: min(i // CW // PAPER_BLOCK, bh - 1) * bw + min(i % CW // PAPER_BLOCK, bw - 1)
    skin_mask = [skin(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) and smooth_rgb(rgb, i % CW, i // CW)
                 and near[at(i)]
                 for i in range(CW * CH)]
    x0, y0, x1, y1 = sheet["box"]
    for part in blobs(skin_mask, CW, CH):
        if len(part) < max(24, HAND_SHARE * CW * CH) or len(part) > 0.5 * sheet["area"]:
            continue
        tableish = False
        if sheet["table"]:
            col = [statistics.median(rgb[i * 3 + c] for i in part) for c in range(3)]
            edge = any(i % CW < 2 or i % CW >= CW - 2 or i // CW < 2 or i // CW >= CH - 2 for i in part)
            tableish = max(abs(col[c] - sheet["table"][c]) for c in range(3)) <= 45
            if tableish and (edge or base is None):
                continue                     # the table's own wood, not a hand on the sheet
        # a hand resting on the sheet has its middle on the sheet; the table beside the sheet
        # touches its border but its middle stays outside
        cx = sum(i % CW for i in part) / len(part) / PAPER_BLOCK
        cy = sum(i // CW for i in part) / len(part) / PAPER_BLOCK
        if base is not None and len(base) == len(rgb):
            changed = sum(1 for i in part if max(abs(rgb[i * 3 + c] - base[i * 3 + c]) for c in range(3)) > 30)
            if changed < (0.5 if tableish else 0.3) * len(part):
                continue
        elif not (x0 <= cx <= x1 + 1 and y0 <= cy <= y1 + 1):
            continue
        inside = sum(1 for i in part if touch[at(i)])
        if inside >= HAND_ON_PAPER * len(part):
            return True
    return False


def look(rgb, base=None):
    """What the settled picture holds: "paper", "hand" (a hand still on it), or "no-paper"."""
    sheet = paper(rgb)
    if sheet is None:
        return "no-paper"
    return "hand" if hand(rgb, sheet, base) else "paper"


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
    if np is not None:
        return (np.array(img, dtype=float).reshape(h, 4, w, 4).sum(axis=(1, 3)) / 16).ravel().tolist()
    return [sum(img[(4 * y + j) * W + 4 * x + i] for j in range(4) for i in range(4)) / 16 for y in range(h) for x in range(w)]


def fit(thumb, base):
    """How the sheet turned and slid since `base` when that is more than paper_shift can follow:
    (degrees, dx, dy) with thumb at R(p - centre) + centre + d ≈ base at p. Searched coarsely on
    quarter-size pictures, then refined at full size. A tenth of a second with numpy, about a second
    without: only for big changes."""
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
        if np is not None:
            flat, v, xs, ys = np.array(padded), np.array(vals), np.array([q[0] for q in pts]), np.array([q[1] for q in pts])
            for a in angles:
                ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
                idx = ((np.rint(sa * (xs - cx) + ca * (ys - cy) + cy).astype(int) + pad) * pw
                       + np.rint(ca * (xs - cx) - sa * (ys - cy) + cx).astype(int) + pad)
                offs = np.array([dy * pw + dx for dx, dy in offsets])
                costs = np.abs(flat[idx[None, :] + offs[:, None]] - v).sum(axis=1)
                k = int(costs.argmin())                  # the first of equals, as the loop below
                if best is None or costs[k] < best[0]:
                    best = (float(costs[k]), a, *offsets[k])
            return best
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


def otsu(img):
    """The brightness that best splits the picture in two (paper above it, table below)."""
    if np is not None:
        hist = np.bincount(np.clip(np.rint(np.array(img, dtype=float)).astype(int) + 255, 0, 510), minlength=511).tolist()
    else:
        hist = [0] * 511
        for v in img:
            hist[min(max(round(v) + 255, 0), 510)] += 1
    n, total, below, below_sum, best = len(img), sum(i * k for i, k in enumerate(hist)), 0, 0, (0, 0)
    for t, k in enumerate(hist):
        below, below_sum = below + k, below_sum + t * k
        if 0 < below < n:
            spread = below * (n - below) * ((total - below_sum) / (n - below) - below_sum / below) ** 2
            if spread > best[0]:
                best = (spread, t - 255)
    return best[1]


def lines(img):
    """The drawing on the paper, on quarter-size blocks (True where a block holds some): sharp dark
    lines with paper-bright, mostly smooth surroundings. Not the table's grain, a sheet's edge against
    the table, or a dark device beside the paper."""
    paper = otsu(img)                                  # paper is brighter than this, the table darker
    if np is not None:
        a = np.array(img, dtype=float).reshape(H, W)
        win = lambda m, r: np.lib.stride_tricks.sliding_window_view(np.pad(m, r, mode="edge"), (2 * r + 1, 2 * r + 1))
        lo, hi = win(a, 2).min(axis=(2, 3)), win(a, 1).max(axis=(2, 3))     # as envelope(img, 2)
        flat = np.pad((hi - lo < 6).astype(int), 4)
        ones = np.pad(np.ones((H, W), int), 4)
        sw = lambda m: np.lib.stride_tricks.sliding_window_view(m, (9, 9)).sum(axis=(2, 3))
        ink = (hi - lo >= INK_EDGE) & (hi > paper) & (sw(flat) >= 0.4 * sw(ones))
        return ink.reshape(H // 4, 4, W // 4, 4).any(axis=(1, 3)).ravel().tolist()
    lo, hi = envelope(img, 2)
    flat = [int(h - l < 6) for l, h in zip(lo, hi)]
    acc = [0] * ((W + 1) * (H + 1))                    # summed-area table of the smooth pixels
    for y in range(H):
        run = 0
        for x in range(W):
            run += flat[y * W + x]
            acc[(y + 1) * (W + 1) + x + 1] = acc[y * (W + 1) + x + 1] + run
    def smooth(x, y, r=4):
        x0, x1, y0, y1 = max(x - r, 0), min(x + r + 1, W), max(y - r, 0), min(y + r + 1, H)
        n = acc[y1 * (W + 1) + x1] - acc[y0 * (W + 1) + x1] - acc[y1 * (W + 1) + x0] + acc[y0 * (W + 1) + x0]
        return n >= 0.4 * (x1 - x0) * (y1 - y0)
    ink = [hi[i] - lo[i] >= INK_EDGE and hi[i] > paper and smooth(i % W, i // W) for i in range(W * H)]
    w, h = W // 4, H // 4
    return [any(ink[(4 * y + j) * W + 4 * x + i] for j in range(4) for i in range(4)) for y in range(h) for x in range(w)]


def far(thumb, base):
    """The same sheet slid far, partly out of view (pulled away, pushed aside): the slide (dx, dy) in
    thumb px that lays `base`'s drawing onto `thumb`'s, where both show, and the brightness offset between
    the pictures there (each thumbnail is centred on its own median, which moves when the table fills the
    view); None when no slide matches (MATCH) on at least OVERLAP of the picture."""
    def score(old, new, w, h, offsets):
        """Best (shared / either, dx, dy) over the offsets: old's line cells landing on new's lines
        (one cell of slack), where the slid pictures overlap on at least OVERLAP of the picture."""
        near = [any(new[(y + j) * w + x + i] for j in (-1, 0, 1) for i in (-1, 0, 1) if 0 <= x + i < w and 0 <= y + j < h)
                for y in range(h) for x in range(w)]
        acc = [0] * ((w + 1) * (h + 1))                # summed-area table of new's lines
        for y in range(h):
            run = 0
            for x in range(w):
                run += new[y * w + x]
                acc[(y + 1) * (w + 1) + x + 1] = acc[y * (w + 1) + x + 1] + run
        cells = [(x, y) for y in range(h) for x in range(w) if old[y * w + x]]
        enough, best = max(30 * w // (W // 4), 0.2 * len(cells)), None
        if np is not None:
            nr = np.pad(np.array(near, dtype=int).reshape(h, w), ((0, 1), (0, 1)))   # (a 0 to point outside at)
            cx, cy = np.array([q[0] for q in cells], dtype=int), np.array([q[1] for q in cells], dtype=int)
            offsets = [(dx, dy) for dx, dy in offsets
                       if (min(w, w - dx) - max(0, -dx)) * (min(h, h - dy) - max(0, -dy)) >= OVERLAP * w * h]
            if not offsets or not len(cells):
                return None
            dxs, dys = np.array([o[0] for o in offsets])[:, None], np.array([o[1] for o in offsets])[:, None]
            X, Y = cx[None, :] + dxs, cy[None, :] + dys
            keep = (X >= 0) & (X < w) & (Y >= 0) & (Y < h)
            was = keep.sum(axis=1)
            both = (nr[np.where(keep, Y, h), np.where(keep, X, w)]).sum(axis=1)
            for k, (dx, dy) in enumerate(offsets):
                x0, x1, y0, y1 = max(0, -dx), min(w, w - dx), max(0, -dy), min(h, h - dy)
                X0, X1, Y0, Y1 = x0 + dx, x1 + dx, y0 + dy, y1 + dy
                now = acc[Y1 * (w + 1) + X1] - acc[Y0 * (w + 1) + X1] - acc[Y1 * (w + 1) + X0] + acc[Y0 * (w + 1) + X0]
                wk, bk = int(was[k]), int(both[k])
                if wk >= enough and (best is None or bk / (wk + now - min(bk, now)) > best[0]):
                    best = (bk / (wk + now - min(bk, now)), dx, dy)
            return best
        for dx, dy in offsets:
            x0, x1, y0, y1 = max(0, -dx), min(w, w - dx), max(0, -dy), min(h, h - dy)
            if (x1 - x0) * (y1 - y0) < OVERLAP * w * h:
                continue
            was = both = 0
            for x, y in cells:
                if x0 <= x < x1 and y0 <= y < y1:
                    was += 1
                    both += near[(y + dy) * w + x + dx]
            X0, X1, Y0, Y1 = x0 + dx, x1 + dx, y0 + dy, y1 + dy
            now = acc[Y1 * (w + 1) + X1] - acc[Y0 * (w + 1) + X1] - acc[Y1 * (w + 1) + X0] + acc[Y0 * (w + 1) + X0]
            if was >= enough and (best is None or both / (was + now - min(both, now)) > best[0]):
                best = (both / (was + now - min(both, now)), dx, dy)
        return best
    w, h = W // 4, H // 4
    old, new = lines(base), lines(thumb)
    half = lambda m: [any(m[(2 * y + j) * w + 2 * x + i] for j in (0, 1) for i in (0, 1)) for y in range(h // 2) for x in range(w // 2)]
    rx, ry = int(w / 2 * (1 - OVERLAP)), int(h / 2 * (1 - OVERLAP))
    best = score(half(old), half(new), w // 2, h // 2, [(x, y) for y in range(-ry, ry + 1) for x in range(-rx, rx + 1)])
    if not best or best[0] < MATCH * 0.8:
        return None
    best = score(old, new, w, h, [(2 * best[1] + x, 2 * best[2] + y) for y in range(-2, 3) for x in range(-2, 3)])
    if not best or best[0] < MATCH:
        return None
    return turned(thumb, base, 4 * best[1], 4 * best[2])


def turned(thumb, base, dx0, dy0):
    """Around the slide (dx0, dy0): the turn (up to TURN°) and slide that fit best where both pictures
    show, ignoring a brightness offset between them; (degrees, dx, dy, offset). Coarse, then fine."""
    cx, cy = (W - 1) / 2, (H - 1) / 2
    def search(angles, offsets, step):
        pts = [(x, y, base[y * W + x]) for y in range(0, H, step) for x in range(0, W, step)]
        best = None
        if np is not None:
            t = np.array(thumb, dtype=float)
            xs, ys, vs = (np.array([q[k] for q in pts], dtype=float) for k in range(3))
            for a in angles:
                ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
                rx, ry = ca * (xs - cx) - sa * (ys - cy) + cx, sa * (xs - cx) + ca * (ys - cy) + cy
                dxs, dys = np.array([o[0] for o in offsets])[:, None], np.array([o[1] for o in offsets])[:, None]
                X, Y = np.rint(rx[None, :] + dxs).astype(int), np.rint(ry[None, :] + dys).astype(int)
                keep = (X >= 0) & (X < W) & (Y >= 0) & (Y < H)
                d = np.where(keep, t[np.clip(Y, 0, H - 1) * W + np.clip(X, 0, W - 1)] - vs[None, :], 0.0)
                n = keep.sum(axis=1)
                with np.errstate(invalid="ignore", divide="ignore"):
                    m = d.sum(axis=1) / n
                    cost = np.where(keep, np.abs(d - m[:, None]), 0.0).sum(axis=1) / n
                for k, (dx, dy) in enumerate(offsets):
                    if n[k] > 0.5 * OVERLAP * len(pts) and (best is None or cost[k] < best[0]):
                        best = (float(cost[k]), a, dx, dy, float(m[k]))
            return best
        for a in angles:
            ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
            rot = [(ca * (x - cx) - sa * (y - cy) + cx, sa * (x - cx) + ca * (y - cy) + cy, v) for x, y, v in pts]
            for dx, dy in offsets:
                d = []
                for X, Y, v in rot:
                    X, Y = round(X + dx), round(Y + dy)
                    if 0 <= X < W and 0 <= Y < H:
                        d.append(thumb[Y * W + X] - v)
                if len(d) > 0.5 * OVERLAP * len(pts):
                    m = sum(d) / len(d)
                    cost = sum(abs(v - m) for v in d) / len(d)
                    if best is None or cost < best[0]:
                        best = (cost, a, dx, dy, m)
        return best
    b = search(range(-TURN, TURN + 1, 2), [(dx0 + x, dy0 + y) for y in range(-4, 5, 2) for x in range(-4, 5, 2)], 8)
    b = search([b[1] + k / 2 for k in range(-2, 3)], [(b[2] + x, b[3] + y) for y in range(-2, 3) for x in range(-2, 3)], 5)
    return b[1], b[2], b[3], b[4]


def warp(thumb, a, d, fill=None, offset=0):
    """`thumb` lined up with the picture it was compared with, after the sheet turned by a degrees
    and slid by d (as fit() or far() measured it): every pixel p takes thumb's value at
    R(p - centre) + centre + d, minus `offset`. Where that is outside the picture: `fill`'s value (the
    sheet went out of view there: nothing to compare), or else the nearest edge pixel's."""
    ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
    cx, cy, out = (W - 1) / 2, (H - 1) / 2, []
    if np is not None:
        ys, xs = np.mgrid[0:H, 0:W]
        X = np.rint(ca * (xs - cx) - sa * (ys - cy) + cx + d[0]).astype(int)
        Y = np.rint(sa * (xs - cx) + ca * (ys - cy) + cy + d[1]).astype(int)
        got = np.array(thumb, dtype=float)[np.clip(Y, 0, H - 1) * W + np.clip(X, 0, W - 1)] - offset
        if fill is not None:
            inside = (X >= 0) & (X < W) & (Y >= 0) & (Y < H)
            got = np.where(inside, got, np.array(fill, dtype=float).reshape(H, W))
        return got.ravel().tolist()
    for y in range(H):
        for x in range(W):
            X = round(ca * (x - cx) - sa * (y - cy) + cx + d[0])
            Y = round(sa * (x - cx) + ca * (y - cy) + cy + d[1])
            if fill is not None and not (0 <= X < W and 0 <= Y < H):
                out.append(fill[y * W + x])
            else:
                out.append(thumb[min(max(Y, 0), H - 1) * W + min(max(X, 0), W - 1)] - offset)
    return out


def line_up(thumb, base, baseline, over=lambda: False):
    """The sheet in `thumb` is the one in `base`, turned (fit) or slid far, partly out of view (far):
    (degrees, dx, dy, what is new after lining up, far?) when the change after lining up is not big,
    else None (a new sheet). `over()` says when the answer isn't wanted any more."""
    a, dx, dy = fit(thumb, base)
    aligned = warp(thumb, a, (dx, dy))
    diff = inky(new_marks(aligned, baseline), aligned, baseline)
    if len(diff) <= BIG * W * H:
        return a, dx, dy, diff, False
    # slid further, partly out of view (live 2026-10-17 15:47: a sheet pulled half off the picture was
    # taken for a new one, and everything on it was built twice): compare where it still shows
    if over():                            # (the picture moved on meanwhile: nobody waits for this verdict)
        return None
    pulled = far(thumb, base)
    if not pulled:
        return None
    a, dx, dy, offset = pulled
    aligned = warp(thumb, a, (dx, dy), fill=base, offset=offset)
    diff = inky(new_marks(aligned, baseline), aligned, baseline)
    return (a, dx, dy, diff, True) if len(diff) <= BIG * W * H else None


class Detector:
    """Feed it snapshots; it returns (reason, changed_indices) when a new sheet has settled.

    Stillness is measured against the picture at the start of the still spell (the anchor),
    not the previous sample, so slow drawing or a creeping shadow also restarts the wait.
    Before comparing with the last sheet handed on, the picture is lined up with it, so paper
    that slid a little isn't news."""
    THREADED = True                          # tests that replay faster than real time line up inline

    def __init__(self, baseline=None):
        self.base = baseline
        self.baseline = baseline and envelope(baseline)
        self.anchor = self.still_since = self.shift = self.moved_at = self.diff = self.measured = None
        self.turn, self.fitted = 0, False    # degrees the sheet turned, and whether fit() lined it up
        self.lining, self.lined = None, {}   # the still spell being lined up in a thread, and results by spell
        self.worker = None                   # that thread
        self.far = False                     # ...and whether far() did: the sheet slid partly out of view
        self.fit_due = False                 # a big change in this still spell that fit() should try
        self.spell = 0                       # counts still spells
        self.patchy = None                   # (diff, scattered?) for the diff it was worked out for
        self.held = None                     # still spell a hand or an empty table keeps from settling
        self.changed = 0                     # pixels that moved when this still spell began

    def feed(self, thumb, t):
        marks = W * H if self.anchor is None else len(new_marks(thumb, self.anchor))
        if self.anchor is None or marks >= NEW_PX:
            if self.anchor is not None:
                self.moved_at = t
            self.anchor, self.still_since, self.shift, self.diff, self.turn = envelope(thumb, 1), t, None, None, 0
            self.fitted = self.far = False
            self.held = None
            self.changed = marks
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
        if self.holding():
            return None
        # lining up a sheet that turned or slid far takes seconds of pure Python: in a thread, started once
        # the big change has been still for STILL_S (a hand pausing on the paper never starts it); the
        # frame waits for its verdict, a sheet waits SHEET_S anyway
        # one thread at a time (a hand resting, lifting and resting again must not stack them up and
        # starve this loop): a newer spell waits for it, and it gives up early once its spell is over
        if self.fit_due and t - self.still_since >= STILL_S and not (self.worker and self.worker.is_alive()):
            self.fit_due = False
            spell, base, baseline = self.spell, self.base, self.baseline
            def work():
                try:
                    self.lined[spell] = line_up(thumb, base, baseline, over=lambda: self.spell != spell)
                except Exception as e:        # never leave the frame waiting for a verdict: a new sheet, then
                    print(f"lining up the sheet failed: {e!r}", file=sys.stderr, flush=True)
                    self.lined[spell] = None
            self.lining = spell
            if self.THREADED:
                self.worker = threading.Thread(target=work, daemon=True)
                self.worker.start()
            else:
                work()
        if self.fit_due:
            return None                       # a line-up is due but hasn't started (one still runs): no verdict yet
        if self.lining == self.spell:
            if self.spell not in self.lined:
                return None                   # still lining up: no verdict yet
            self.lining, found = None, self.lined.pop(self.spell)
            self.lined.clear()                # (older spells' results are of no use any more)
            if found:
                a, dx, dy, diff, self.far = found
                self.turn, self.shift, self.diff, self.fitted = a, (dx, dy), diff, True
        diff = self.diff
        if len(diff) < NEW_PX:
            return None
        big = self.big()
        if t - self.still_since < (STILL_S if not big else SHEET_S if (self.scattered() or self.swapped()) else BIG_S):
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
        self.fitted = self.far = False
        self.changed = 0
        return ("big-change" if big else "drawn"), diff

    def hold(self):
        """A hand is on the paper (or there is no paper): this still spell must not settle."""
        self.held = self.spell

    def holding(self):
        return self.held == self.spell

    def candidate(self):
        """The still spell whose settled picture should be checked for a hand or for paper, if any."""
        return self.spell if (not self.holding()
                              and ((self.diff and len(self.diff) >= NEW_PX) or self.changed >= BIG * W * H)) else None

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

    def swapped(self):
        """The change fills most of the picture in one piece: a new sheet, of any colour, laid over
        the old one. A hand reaches in from one side and never spans the whole picture."""
        if not self.diff:
            return False
        xs, ys = [i % W for i in self.diff], [i // W for i in self.diff]
        return (len(self.diff) >= 0.3 * W * H
                and max(xs) - min(xs) >= 0.8 * W and max(ys) - min(ys) >= 0.8 * H)

    def big(self):
        """A large change, or a sheet that slid further than we can line up."""
        return (len(self.diff) > BIG * W * H or self.far
                or (self.baseline is not None and not self.fitted and max(map(abs, self.shift)) >= SLIDE))

    def drawing(self):
        """Still for EARLY_S with a small change in it: a drawing that will be handed on at STILL_S
        unless something moves first (this still spell's number), else None."""
        return self.spell if self.diff and len(self.diff) >= NEW_PX and not self.big() else None

    def undo(self, t):
        """The last emit didn't happen after all: back to the sheet before it, wait for stillness again."""
        self.base, self.baseline = self.prev
        self.anchor, self.still_since, self.shift, self.diff, self.turn, self.fitted = None, t, None, None, 0, False
        self.far, self.held, self.changed = False, None, 0


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
        self.spell, self.result, self.checked = spell, None, False
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
        self.result = data, size, size and small(data), size and colour(data)

    def ready(self):
        return not self.thread.is_alive()

    def get(self):
        """(data, size, grey thumbnail or None, colour thumbnail or None), or raises the fetch's OSError."""
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


def held_status(status, held):
    """Tell the viewer why a settled picture is not being handed on."""
    if held == "hand":
        status.set("moving", "hand on the paper")
    else:
        status.set("no-paper", "no paper")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    done = sorted(OUT.glob("*.jpg"))
    previous = done[-1].name if done else None
    det = Detector(small(done[-1].read_bytes()) if done else None)
    base_rgb = colour(done[-1].read_bytes()) if done else None
    status, stream, url, seq, checked, cam, early = Status(), None, None, 0, 0, None, None
    held, held_spell = None, 0
    while True:
        if time.monotonic() - checked > 1:   # the picker may switch cameras at any time
            checked, cam = time.monotonic(), camera()
            if cam is None or cam[0] != url:
                if url is not None:
                    base_rgb = None              # another camera's picture is no base for this one
                if stream:
                    stream.stop()
                stream, url, seq, det.anchor = None, cam and cam[0], 0, None
                early, held, held_spell = None, None, 0
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
        if held and det.spell == held_spell:
            det.hold()                       # a hand or an empty table still holds this spell
        spell = det.candidate()
        if spell and (early is None or (early.spell != spell and early.checked)):
            early = Snapshot(url, spell)      # settled for EARLY_S: fetch it while the still time runs
        # once that picture is here, is a hand still on the paper, or is there no paper at all?
        if early and not early.checked and early.ready():
            early.checked = True
            try:
                _, _, snap, rgb = early.get()
            except OSError as e:
                print(f"camera snapshot: {e}", file=sys.stderr, flush=True)
                snap = rgb = None
            if rgb:
                found = look(rgb, base_rgb)
                if found != "paper":
                    det.hold()
                    held, held_spell = found, det.spell
                elif early.spell == det.spell:
                    held = None               # this settled picture has paper and no hand
            if early.spell != det.spell:
                early = None                  # a newer still spell: look at that one next
        if held:
            held_status(status, held)
            continue
        if not got:
            status.set("moving" if det.moved_at and t - det.moved_at < STILL_S + 1 else "watching")
            continue
        # hand on the full-size picture, not the thumbnail: the one fetched early in this still
        # spell, or (the stream moved on) one fetched now
        shot = early if early and early.spell == det.spell else Snapshot(url, None)
        early = None
        try:
            data, size, snap, rgb = shot.get()
        except OSError as e:
            print(f"camera snapshot: {e}", file=sys.stderr, flush=True)
            det.undo(t)                       # don't lose the drawing: let it settle and try again
            continue
        if not snap or len(new_marks(snap, det.anchor)) >= SNAP_DIFF:
            # the snapshot isn't the picture that settled (a hand came back): let it settle again
            print("snapshot differs from the settled picture; waiting again", file=sys.stderr, flush=True)
            det.undo(t)
            early, held = None, None
            continue
        found = look(rgb, base_rgb) if rgb else "paper"
        if found != "paper":
            det.hold()
            shot.checked, held, held_spell = True, found, det.spell
            early = shot
            held_status(status, held)
            continue
        previous = hand_on(data, size, *got, cam[1], previous, det.measured if previous else None)
        base_rgb = rgb
        meta = json.loads((OUT / previous.replace(".jpg", ".json")).read_text())
        try:
            cut = cutout(data, meta["changed_box"], size, STATUS / "cutout.png", got[1])
        except (subprocess.SubprocessError, OSError):
            cut = False
        status.last = {"frame": previous[:-4], "at": time.time(), "reason": got[0], "box": meta["changed_box"],
                       "width": size[0], "height": size[1], "cutout": cut}
        status.set("settled", previous[:-4])
        held = None

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
