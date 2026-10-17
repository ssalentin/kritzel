"""Share this machine's cameras with the paper world over the network (e.g. Tailscale).

Run it on the machine the camera is plugged into:
    python3 scripts/camera_server.py            # listens on 127.0.0.1 and this machine's Tailscale IP, port 8766
The viewer's server finds it on every online tailnet peer and lists its cameras.
It never listens on the LAN: anyone there could watch the camera. CAMERA_HOST=<addr> overrides.

  GET /cameras.json            → {"host": ..., "cameras": [{"id", "name", "stream", "snapshot"}]}
  GET /stream/<id>.mjpg        → MJPEG stream (multipart/x-mixed-replace), full size
  GET /snapshot/<id>.jpg       → the latest frame, full size
  add ?small to either         → the preview: PREVIEW_W px wide, PREVIEW_FPS a second, ~25 KB a frame

Needs Linux (V4L2) and ffmpeg. One ffmpeg per camera, shared by all viewers;
it stops a few seconds after the last viewer leaves. Watch the small preview over a thin
network link: a full-size frame is ~200 KB, a preview ~25 KB.
"""
import http.server
import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path

PORT = int(os.environ.get("CAMERA_PORT", "8766"))
SIZE = os.environ.get("CAMERA_SIZE", "1920x1080")    # what start.sh uses for the IPEVO
PREVIEW_W, PREVIEW_FPS = 960, 15     # 960 px is the size capture.py compares at
SNDBUF = 64 << 10                     # a stream socket holds a few previews, not seconds of video


def source(cam):
    """ffmpeg's input options for a camera."""
    return ["-f", "v4l2", "-input_format", "mjpeg", "-video_size", SIZE, "-i", f"/dev/{cam}"]


def cameras():
    """Capture nodes only: a UVC camera also exposes a metadata node (index 1)."""
    out = []
    for d in sorted(Path("/sys/class/video4linux").glob("video*"), key=lambda p: int(p.name[5:])):
        if (d / "index").read_text().strip() != "0":
            continue
        out.append({"id": d.name, "name": (d / "name").read_text().strip(),
                    "stream": f"/stream/{d.name}.mjpg", "snapshot": f"/snapshot/{d.name}.jpg"})
    return out


class Feed:
    """One ffmpeg reading a camera; keeps the latest JPEG for every client."""
    feeds, lock = {}, threading.Lock()

    @classmethod
    def get(cls, cam):
        with cls.lock:
            f = cls.feeds.get(cam)
            if not f or not f.alive or f.proc.poll() is not None:
                f = cls.feeds[cam] = Feed(cam)
            f.clients += 1
            return f

    def __init__(self, cam):
        # the latest JPEG of each size: {"full"|"small": (frame, seq)}
        self.latest, self.clients, self.alive, self.error = {"full": (None, 0), "small": (None, 0)}, 0, True, ""
        self.last_frame = self.idle_since = time.time()
        self.cam, self.cond = cam, threading.Condition()
        r, w = os.pipe()
        # two outputs: full size on stdout as before, the shrunken preview on the extra pipe
        self.proc = subprocess.Popen(
            ["ffmpeg", "-loglevel", "warning", *source(cam),
             "-map", "0:v", "-f", "mjpeg", "-q:v", "3", "pipe:1",
             "-map", "0:v", "-vf", f"fps={PREVIEW_FPS},scale={PREVIEW_W}:-2:flags=area", "-q:v", "8",
             "-f", "mjpeg", f"pipe:{w}"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(w,))
        os.close(w)
        threading.Thread(target=self.read, args=(self.proc.stdout, "full"), daemon=True).start()
        threading.Thread(target=self.read, args=(os.fdopen(r, "rb"), "small"), daemon=True).start()
        threading.Thread(target=self.log, daemon=True).start()
        threading.Thread(target=self.watchdog, daemon=True).start()

    def watchdog(self):
        # stop ffmpeg when nobody watches for 5 s, or when the camera stalls (no frame for 10 s);
        # killing it ends read() even if ffmpeg hangs without exiting
        while self.proc.poll() is None:
            time.sleep(1)
            now = time.time()
            if self.clients > 0:
                self.idle_since = now
            if now - self.idle_since > 5 or now - self.last_frame > 10:
                self.stop()

    def stop(self):
        with Feed.lock:                     # new clients get a fresh feed from here on
            self.alive = False
        self.proc.kill()

    def log(self):
        # show ffmpeg's messages in this terminal, keep the last ones for the 503 answer
        for line in self.proc.stderr:
            line = line.decode(errors="replace").strip()
            if not line:
                continue
            print(f"{self.cam}: {line}", flush=True)
            self.error = line[-300:]

    def read(self, pipe, kind):
        buf = b""
        while True:
            chunk = pipe.read1(65536)
            if not chunk:
                break
            buf += chunk
            # split the byte stream into JPEGs at the end-of-image marker
            while (end := buf.find(b"\xff\xd9")) != -1:
                start = buf.find(b"\xff\xd8")
                if 0 <= start < end:
                    with self.cond:
                        self.latest[kind] = buf[start:end + 2], self.latest[kind][1] + 1
                        self.last_frame = time.time()
                        self.cond.notify_all()
                buf = buf[end + 2:]
        self.proc.kill()
        self.proc.wait()
        time.sleep(0.2)                     # let the log thread catch ffmpeg's last words
        self.stop()
        with self.cond:
            self.cond.notify_all()

    def release(self):
        with Feed.lock:
            self.clients -= 1

    def next(self, kind, seq, timeout=5):
        with self.cond:
            self.cond.wait_for(lambda: self.latest[kind][1] != seq or not self.alive, timeout)
            return self.latest[kind]


class Handler(http.server.BaseHTTPRequestHandler):
    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path, kind = url.path, "small" if "small" in urllib.parse.parse_qs(url.query, keep_blank_values=True) else "full"
        if path == "/cameras.json":
            return self.send(200, json.dumps({"host": socket.gethostname(), "cameras": cameras()}).encode(),
                             "application/json")
        m = re.fullmatch(r"/(stream|snapshot)/(video\d+)\.(mjpg|jpg)", path)
        if not m or m[2] not in {c["id"] for c in cameras()}:
            return self.send(404, b"not found", "text/plain")
        feed = Feed.get(m[2])
        try:
            frame, seq = feed.next(kind, 0)
            if frame is None:
                msg = "camera gives no picture: " + (feed.error or "no frame within 5 s")
                print(f"{m[2]}: {msg}")
                return self.send(503, msg.encode(), "text/plain")
            if m[1] == "snapshot":
                return self.send(200, frame, "image/jpeg")
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            # a small send buffer: when the link is slower than the stream, frames are skipped
            # here (next() always gives the newest) instead of queueing up as lag
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, SNDBUF)
            while feed.alive:
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(frame))
                self.wfile.write(frame + b"\r\n")
                frame, seq = feed.next(kind, seq)
        except OSError:
            pass
        finally:
            feed.release()

    def log_message(self, *args):
        pass


def addresses():
    if os.environ.get("CAMERA_HOST"):
        return [os.environ["CAMERA_HOST"]]
    try:
        ts = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3).stdout.split()
    except (OSError, subprocess.SubprocessError):
        ts = []
    if not ts:
        print("no Tailscale IP found: only reachable from this machine (set CAMERA_HOST to change)")
    return ["127.0.0.1", *ts[:1]]


if __name__ == "__main__":
    print("cameras:", ", ".join(f"{c['id']} ({c['name']})" for c in cameras()) or "none found")
    addrs = addresses()
    servers = [http.server.ThreadingHTTPServer((a, PORT), Handler) for a in addrs]
    print("listening on", ", ".join(f"{a}:{PORT}" for a in addrs))
    for srv in servers[1:]:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    servers[0].serve_forever()
