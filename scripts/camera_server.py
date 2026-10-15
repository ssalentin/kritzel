"""Share this machine's cameras with the paper world over the network (e.g. Tailscale).

Run it on the machine the camera is plugged into:
    python3 scripts/camera_server.py            # listens on 0.0.0.0:8766
The viewer's server finds it on every online tailnet peer and lists its cameras.

  GET /cameras.json            → {"host": ..., "cameras": [{"id", "name", "stream", "snapshot"}]}
  GET /stream/<id>.mjpg        → MJPEG stream (multipart/x-mixed-replace)
  GET /snapshot/<id>.jpg       → the latest frame

Needs Linux (V4L2) and ffmpeg. One ffmpeg per camera, shared by all viewers;
it stops a few seconds after the last viewer leaves.
"""
import http.server
import json
import os
import re
import socket
import subprocess
import threading
import time
from pathlib import Path

PORT = int(os.environ.get("CAMERA_PORT", "8766"))
SIZE = os.environ.get("CAMERA_SIZE", "1920x1080")    # what start.sh uses for the IPEVO


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
            if not f or not f.alive:
                f = cls.feeds[cam] = Feed(cam)
            f.clients += 1
            return f

    def __init__(self, cam):
        self.frame, self.seq, self.clients, self.alive, self.error = None, 0, 0, True, ""
        self.cam, self.cond = cam, threading.Condition()
        self.proc = subprocess.Popen(
            ["ffmpeg", "-loglevel", "warning", "-f", "v4l2", "-input_format", "mjpeg", "-video_size", SIZE,
             "-i", f"/dev/{cam}", "-f", "mjpeg", "-q:v", "5", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        threading.Thread(target=self.read, daemon=True).start()
        threading.Thread(target=self.log, daemon=True).start()

    def log(self):
        # show ffmpeg's messages in this terminal, keep the last ones for the 503 answer
        for line in self.proc.stderr:
            line = line.decode(errors="replace").strip()
            if not line:
                continue
            print(f"{self.cam}: {line}", flush=True)
            self.error = line[-300:]

    def read(self):
        buf, idle_since = b"", None
        while True:
            chunk = self.proc.stdout.read1(65536)
            if not chunk:
                break
            buf += chunk
            # split the byte stream into JPEGs at the end-of-image marker
            while (end := buf.find(b"\xff\xd9")) != -1:
                start = buf.find(b"\xff\xd8")
                if 0 <= start < end:
                    with self.cond:
                        self.frame, self.seq = buf[start:end + 2], self.seq + 1
                        self.cond.notify_all()
                buf = buf[end + 2:]
            idle_since = (idle_since or time.time()) if self.clients == 0 else None
            if idle_since and time.time() - idle_since > 5:
                break
        self.proc.kill()
        self.proc.wait()
        time.sleep(0.2)                     # let the log thread catch ffmpeg's last words
        self.alive = False
        with self.cond:
            self.cond.notify_all()

    def release(self):
        with Feed.lock:
            self.clients -= 1

    def next(self, seq, timeout=5):
        with self.cond:
            self.cond.wait_for(lambda: self.seq != seq or not self.alive, timeout)
            return self.frame, self.seq


class Handler(http.server.BaseHTTPRequestHandler):
    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/cameras.json":
            return self.send(200, json.dumps({"host": socket.gethostname(), "cameras": cameras()}).encode(),
                             "application/json")
        m = re.fullmatch(r"/(stream|snapshot)/(video\d+)\.(mjpg|jpg)", self.path)
        if not m or m[2] not in {c["id"] for c in cameras()}:
            return self.send(404, b"not found", "text/plain")
        feed = Feed.get(m[2])
        try:
            frame, seq = feed.next(0)
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
            while feed.alive:
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(frame))
                self.wfile.write(frame + b"\r\n")
                frame, seq = feed.next(seq)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            feed.release()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"cameras on :{PORT}:", ", ".join(f"{c['id']} ({c['name']})" for c in cameras()) or "none found")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
