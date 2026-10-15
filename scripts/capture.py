"""Capture stage: watch the chosen camera, hand each finished drawing to the generate stage.

    python3 scripts/capture.py            # needs viewer/serve.py running (it proxies the camera)

Reads camera.json (written by the viewer's camera picker; only kind=remote for now), takes a
snapshot every half second through the viewer's server and waits for the picture to settle.
When the settled sheet differs from the last one handed on, it writes

    frames/settled/<YYYYmmdd-HHMMSS>.json   first: {captured_at, camera, previous, reason,
                                                     changed, changed_box: [x, y, w, h] px}
    frames/settled/<YYYYmmdd-HHMMSS>.jpg    then, atomically: the camera's JPEG as it came

No frame while something moves (a drawing hand), none when nothing changed. A small change
counts once still for STILL_S ("drawn"); a large one (new sheet, moved paper, a resting hand)
must stay still for BIG_S ("big-change"). Needs ffmpeg. Env: VIEWER (default
http://127.0.0.1:8765), KRITZEL_ROOT (where camera.json and frames/ live).
"""
import datetime
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("KRITZEL_ROOT", Path(__file__).resolve().parent.parent))
OUT = ROOT / "frames" / "settled"
VIEWER = os.environ.get("VIEWER", "http://127.0.0.1:8765")
W, H = 320, 180          # compare at this size: averages away sensor noise, keeps pencil lines
PIXEL = 20               # brightness step (0-255) that counts as a changed pixel
NEW_PX = 15              # changed pixels that count: vs the still picture = movement, vs the last sheet = new
INK_R = 2                # new ink must be this far (thumb px) from ink already there
SLIDE = 5                # how far (thumb px, ×6 at 1080p) the paper may slide and still be the same sheet
BIG = 0.04               # share changed that is a big change, not drawing
STILL_S, BIG_S, EVERY_S = 1.2, 8.0, 0.5   # a sample itself takes ~0.65 s (fetch + ffmpeg)
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


def small(data):
    """Grey W×H thumbnail, brightness centred on its median (so exposure drift is no change)."""
    try:
        px = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "jpeg_pipe", "-i", "-", "-vf",
                             f"format=gray,scale=960:540:flags=area,erosion,erosion,scale={W}:{H}:flags=area",
                             "-f", "rawvideo", "-"], input=data, capture_output=True, timeout=10).stdout
    except (subprocess.SubprocessError, OSError) as e:
        print(f"ffmpeg: {e}", file=sys.stderr, flush=True)
        return None
    if len(px) != W * H:
        return None
    m = statistics.median(px[::7])
    return [p - m for p in px]


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
    m = 2 * SLIDE
    return [i for i in sorted(hit) if m <= i % W < W - m and m <= i // W < H - m
            and sum(j in hit for j in (i - 1, i + 1, i - W, i + W, i - W - 1, i - W + 1, i + W - 1, i + W + 1)) >= 2]


def paper_shift(thumb, base):
    """How far (dx, dy) the sheet slid since `base`: the offset that fits best, up to SLIDE px."""
    pts = [(x, y) for y in range(SLIDE, H - SLIDE, 3) for x in range(SLIDE, W - SLIDE, 3)]
    cost = lambda d: sum(abs(thumb[(y + d[1]) * W + x + d[0]] - base[y * W + x]) for x, y in pts)
    return min(((dx, dy) for dy in range(-SLIDE, SLIDE + 1) for dx in range(-SLIDE, SLIDE + 1)),
               key=lambda d: (cost(d), abs(d[0]) + abs(d[1])))


def moved(thumb, d):
    """`thumb` slid back by d, so it lines up with the picture it was compared with."""
    dx, dy = d
    return [thumb[min(max(y + dy, 0), H - 1) * W + min(max(x + dx, 0), W - 1)] for y in range(H) for x in range(W)]


class Detector:
    """Feed it snapshots; it returns (reason, changed_indices) when a new sheet has settled.

    Stillness is measured against the picture at the start of the still spell (the anchor),
    not the previous sample, so slow drawing or a creeping shadow also restarts the wait.
    Before comparing with the last sheet handed on, the picture is lined up with it, so paper
    that slid a little isn't news."""

    def __init__(self, baseline=None):
        self.base = baseline
        self.baseline = baseline and envelope(baseline)
        self.anchor = self.still_since = self.shift = None

    def feed(self, thumb, t):
        if self.anchor is None or len(new_marks(thumb, self.anchor)) >= NEW_PX:
            self.anchor, self.still_since, self.shift = envelope(thumb, 1), t, None
            return None
        if self.baseline is None:
            diff, self.shift = list(range(W * H)), (0, 0)
        else:
            if self.shift is None:
                self.shift = paper_shift(thumb, self.base)
            diff = new_marks(moved(thumb, self.shift), self.baseline)
            if len(diff) < NEW_PX:
                return None
        big = len(diff) > BIG * W * H
        if t - self.still_since < (BIG_S if big else STILL_S):
            return None
        dx, dy = self.shift                  # report where the change is in the new picture
        self.base, self.baseline, self.still_since, self.shift = thumb, envelope(thumb), t, (0, 0)
        diff = [min(max(i // W + dy, 0), H - 1) * W + min(max(i % W + dx, 0), W - 1) for i in diff]
        return ("big-change" if big else "drawn"), diff


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


def hand_on(data, size, reason, diff, info, previous):
    now = datetime.datetime.now()
    stem = now.strftime("%Y%m%d-%H%M%S")
    meta = {"captured_at": now.astimezone().isoformat(timespec="seconds"), "camera": info,
            "previous": previous, "reason": reason, "changed": round(len(diff) / (W * H), 4),
            "changed_box": box(diff, size), "width": size[0], "height": size[1]}
    for name, body in ((f"{stem}.json", json.dumps(meta, indent=2).encode() + b"\n"), (f"{stem}.jpg", data)):
        tmp = OUT / (name + ".tmp")
        tmp.write_bytes(body)
        tmp.replace(OUT / name)
    print(f"{stem}: {reason}, {meta['changed']:.1%} changed, box {meta['changed_box']}", flush=True)
    return f"{stem}.jpg"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    done = sorted(OUT.glob("*.jpg"))
    previous = done[-1].name if done else None
    det = Detector(small(done[-1].read_bytes()) if done else None)
    url = None
    next_at = 0
    while True:
        time.sleep(max(0, next_at - time.monotonic()))
        next_at = time.monotonic() + EVERY_S
        cam = camera()
        if cam is None:
            if url != "":
                print("no remote camera chosen in camera.json; waiting", flush=True)
            url = ""
            continue
        if cam[0] != url:
            url, det.anchor = cam[0], None
            print(f"watching {cam[1]['name']} on {cam[1]['host']}", flush=True)
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                data = r.read(MAX_BYTES + 1)
        except OSError as e:
            print(f"camera: {e}", file=sys.stderr, flush=True)
            time.sleep(2)
            continue
        size = jpeg_size(data)
        thumb = size and small(data)
        if not thumb:
            print("camera sent something that isn't a usable JPEG; skipped", file=sys.stderr, flush=True)
            continue
        if got := det.feed(thumb, time.monotonic()):
            previous = hand_on(data, size, *got, cam[1], previous)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
