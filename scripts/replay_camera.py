"""A camera that plays recorded sheets instead of a real one: for testing the whole pipeline
(capture → generate → viewer) without the camera, and for QA.

    python3 scripts/replay_camera.py [--port N] [--fps 10] [--hand 2.5] SHEET.jpg[:HOLD_S] ...

It serves scripts/camera_server.py's API on 127.0.0.1 (CAMERA_PORT, default 8766; --port 0 picks
a free one and prints it), with one camera, video0 ("Replay"):

  GET /cameras.json, /stream/video0.mjpg, /snapshot/video0.jpg   (?small: the 960 px preview)
  GET /state.json   → {"sheet": index, "file", "phase": "hand"|"still", "since": unix time}
  GET /next         → end the current sheet's hold now (the hand comes and lays down the next one)

Each sheet (a recorded frame, e.g. frames/settled/<ts>.jpg) lies still for HOLD_S seconds
(default 30; the last one stays). Between two sheets a hand comes in from the side, moves
over the paper and leaves, for --hand seconds; the next sheet appears under it halfway. So
capture sees what it sees at the real table: movement, then stillness. Every phase change
is printed with its time. Needs ffmpeg (once at start, to prepare the frames).
"""
import argparse
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

SIZE, SMALL_W = (1920, 1080), 960


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)


def prepare(sheets, fps, hand_s, work):
    """JPEG frames for every phase: [(kind, [full jpegs], [small jpegs])]; kind 'still' or 'hand'."""
    w, h = SIZE
    # a hand: a skin-coloured palm and forearm (and its soft shadow), reaching in from the bottom right
    hand = work / "hand.png"
    ffmpeg("-f", "lavfi", "-i", f"color=c=0xd9ab8c:s={w}x{h},format=rgba", "-frames:v", "1", "-vf",
           f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*(lt(hypot((X-300)/190,(Y-260)/150),1)"
           f"+lt(abs((Y-260)-(X-300)*0.62)*1.2,130)*gt(X,300))'", str(hand))
    phases, scale = [], f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
    for i, sheet in enumerate(sheets):
        still = work / f"{i:02d}.jpg"
        ffmpeg("-i", str(sheet), "-vf", scale, "-q:v", "3", str(still))
        if i:
            out = work / f"hand{i:02d}"
            out.mkdir()
            n = max(2, round(hand_s * fps))
            # in from outside (u = 0) to the middle of the sheet (u = 0.5) and out again; the
            # new sheet lies under the hand from halfway on
            u = f"(n/{n - 1})"
            ffmpeg("-loop", "1", "-i", str(work / f"{i - 1:02d}.jpg"), "-loop", "1", "-i", str(still), "-i", str(hand),
                   "-filter_complex",
                   f"[0][1]overlay=enable='gte(n,{n // 2})'[b];"
                   f"[b][2]overlay=x='{w * 0.25}+{w * 0.75}*abs(2*{u}-1)+60*sin(n*0.9)':"
                   f"y='{h * 0.35}+{h * 0.65}*abs(2*{u}-1)+40*sin(n*1.3)':eval=frame",
                   "-frames:v", str(n), "-q:v", "4", str(out / "%03d.jpg"))
            phases.append(("hand", sorted(out.glob("*.jpg"))))
        phases.append(("still", [still]))
    out = []
    for kind, files in phases:
        small = []
        for f in files:
            s = f.with_name(f.stem + "-small.jpg")
            ffmpeg("-i", str(f), "-vf", f"scale={SMALL_W}:-2:flags=area", "-q:v", "8", str(s))
            small.append(s.read_bytes())
        out.append((kind, [f.read_bytes() for f in files], small))
    return out


class Player:
    """Walks through the phases in real time; keeps the current frame of each size."""

    def __init__(self, phases, holds, fps, names):
        self.phases, self.holds, self.fps, self.names = phases, holds, fps, names
        self.cond, self.skip = threading.Condition(), threading.Event()
        self.seq, self.frame, self.state = 0, {}, {}
        threading.Thread(target=self.run, daemon=True).start()

    def show(self, full, small):
        with self.cond:
            self.frame, self.seq = {"full": full, "small": small}, self.seq + 1
            self.cond.notify_all()

    def run(self):
        sheet = 0
        for k, (kind, full, small) in enumerate(self.phases):
            if kind == "still" and k:
                sheet += 1
            self.state = {"sheet": sheet, "file": self.names[sheet], "phase": kind, "since": time.time()}
            print(f"{time.strftime('%H:%M:%S')} {time.time():.3f} sheet {sheet} {kind} {self.names[sheet]}", flush=True)
            if kind == "hand":
                for f, s in zip(full, small):
                    self.show(f, s)
                    time.sleep(1 / self.fps)
                continue
            last = k == len(self.phases) - 1
            self.skip.clear()
            end = time.time() + self.holds[sheet]
            while last or (time.time() < end and not self.skip.is_set()):
                self.show(full[0], small[0])
                self.skip.wait(1 / self.fps)
        print(f"{time.strftime('%H:%M:%S')} end of playlist", flush=True)

    def next(self, kind, seq, timeout=5):
        with self.cond:
            self.cond.wait_for(lambda: self.seq != seq, timeout)
            return self.frame.get(kind), self.seq


def handler(player):
    class Handler(http.server.BaseHTTPRequestHandler):
        def send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path, _, query = self.path.partition("?")
            kind = "small" if "small" in query.split("&") else "full"
            if path == "/cameras.json":
                cam = {"id": "video0", "name": "Replay", "stream": "/stream/video0.mjpg", "snapshot": "/snapshot/video0.jpg"}
                return self.send(200, json.dumps({"host": "replay", "cameras": [cam]}).encode(), "application/json")
            if path == "/state.json":
                return self.send(200, json.dumps(player.state).encode(), "application/json")
            if path == "/next":
                player.skip.set()
                return self.send(200, b"ok", "text/plain")
            if path == "/snapshot/video0.jpg":
                return self.send(200, player.next(kind, -1)[0], "image/jpeg")
            if path != "/stream/video0.mjpg":
                return self.send(404, b"not found", "text/plain")
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            seq = -1
            try:
                while True:
                    frame, seq = player.next(kind, seq)
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(frame))
                    self.wfile.write(frame + b"\r\n")
            except OSError:
                pass

        def log_message(self, *args):
            pass
    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=int(os.environ.get("CAMERA_PORT", "8766")))
    ap.add_argument("--fps", type=float, default=10)
    ap.add_argument("--hand", type=float, default=2.5, help="seconds a hand moves between two sheets")
    ap.add_argument("sheets", nargs="+", help="SHEET.jpg[:HOLD_S]")
    a = ap.parse_args()
    files, holds = [], []
    for s in a.sheets:
        f, _, hold = s.rpartition(":") if s.rpartition(":")[2].replace(".", "").isdigit() else (s, "", "30")
        if not Path(f).is_file():
            sys.exit(f"no such sheet: {f}")
        files.append(Path(f))
        holds.append(float(hold))
    work = Path(tempfile.mkdtemp(prefix="replay-camera-"))
    try:
        print(f"preparing {len(files)} sheets…", flush=True)
        phases = prepare(files, a.fps, a.hand, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), handler(Player(phases, holds, a.fps, [f.name for f in files])))
    print(f"replay camera on 127.0.0.1:{srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
