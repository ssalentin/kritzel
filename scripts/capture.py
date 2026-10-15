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
MOVING = 0.002           # share of pixels changed between two samples that means "something moves"
NEW_PX = 15              # changed pixels vs the last handed-on sheet that make it new
BIG = 0.04               # share changed that is a big change, not drawing
STILL_S, BIG_S, EVERY_S = 3.0, 8.0, 0.5
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
    px = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "jpeg_pipe", "-i", "-", "-vf",
                         f"format=gray,scale=960:540:flags=area,erosion,erosion,scale={W}:{H}:flags=area", "-f", "rawvideo", "-"],
                        input=data, capture_output=True, timeout=10).stdout
    if len(px) != W * H:
        return None
    m = statistics.median(px[::7])
    return [p - m for p in px]


def changed(a, b):
    return [i for i, (x, y) in enumerate(zip(a, b)) if abs(x - y) > PIXEL]


def envelope(thumb):
    """Darkest and brightest value around each pixel (3×3), so a camera that shifts by a
    pixel doesn't make the lines already on the sheet look new."""
    lo, hi = [], []
    for i in range(W * H):
        x, y = i % W, i // W
        near = [thumb[v * W + u] for v in range(max(y - 1, 0), min(y + 2, H)) for u in range(max(x - 1, 0), min(x + 2, W))]
        lo.append(min(near))
        hi.append(max(near))
    return lo, hi


def new_marks(thumb, env):
    return [i for i, (x, lo, hi) in enumerate(zip(thumb, *env)) if x < lo - PIXEL or x > hi + PIXEL]


class Detector:
    """Feed it snapshots; it returns (reason, changed_indices) when a new sheet has settled."""

    def __init__(self, baseline=None):
        self.baseline = baseline and envelope(baseline)
        self.last = self.still_since = None

    def feed(self, thumb, t):
        moving = self.last is None or len(changed(thumb, self.last)) > MOVING * W * H
        self.last = thumb
        if moving:
            self.still_since = None
            return None
        if self.still_since is None:
            self.still_since = t
        if self.baseline is None:
            diff = list(range(W * H))
        else:
            diff = new_marks(thumb, self.baseline)
            if len(diff) < NEW_PX:
                return None
        big = len(diff) > BIG * W * H
        if t - self.still_since < (BIG_S if big else STILL_S):
            return None
        self.baseline = envelope(thumb)
        return ("big-change" if big else "drawn"), diff


def box(diff, size):
    xs, ys = [i % W for i in diff], [i // W for i in diff]
    sx, sy = size[0] / W, size[1] / H
    x0, y0 = int(min(xs) * sx), int(min(ys) * sy)
    return [x0, y0, int((max(xs) + 1) * sx) - x0, int((max(ys) + 1) * sy) - y0]


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
    while True:
        time.sleep(EVERY_S)
        cam = camera()
        if cam is None:
            if url != "":
                print("no remote camera chosen in camera.json; waiting", flush=True)
            url = ""
            continue
        if cam[0] != url:
            url, det.last = cam[0], None
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
