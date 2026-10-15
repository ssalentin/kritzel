"""Serve the camera folder on localhost:8765 with caching disabled,
so the viewer always picks up the latest world.js and camera frames.

Camera selection (see scripts/camera_server.py for the remote side):
  GET /api/cameras              → remote cameras found on online Tailscale peers (and this host)
  GET /api/camera-stream/<ip>/<id>.mjpg|.jpg → that camera, proxied (same origin, works under https)
  GET/PUT /api/camera           → the chosen camera, kept in camera.json for the capture stage

HOST / PORT env vars change the listen address (default 127.0.0.1:8765).
"""
import functools
import http.server
import json
import os
import re
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHOICE = ROOT / "camera.json"
CAMERA_PORT = 8766


def tailnet_hosts():
    """(name, ip) of this host and every online Tailscale peer."""
    hosts = [("this computer", "127.0.0.1")]
    try:
        st = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, timeout=3).stdout)
        hosts += [((p.get("DNSName") or p["HostName"]).split(".")[0], p["TailscaleIPs"][0]) for p in st.get("Peer", {}).values()
                  if p.get("Online") and p.get("TailscaleIPs")]
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return hosts


def probe(host):
    name, ip = host
    try:
        with urllib.request.urlopen(f"http://{ip}:{CAMERA_PORT}/cameras.json", timeout=1.5) as r:
            cams = json.load(r)["cameras"]
    except (OSError, ValueError, KeyError):
        return []
    return [{"kind": "remote", "host": name, "ip": ip, "id": c["id"], "name": c["name"],
             "stream": f"/api/camera-stream/{ip}/{c['id']}.mjpg"} for c in cams]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/cameras":
            hosts = tailnet_hosts()
            with ThreadPoolExecutor(16) as ex:
                return self.json([c for cams in ex.map(probe, hosts) for c in cams])
        if self.path == "/api/camera":
            try:
                return self.json(json.loads(CHOICE.read_text()))
            except (OSError, ValueError):
                return self.json(None)
        m = re.fullmatch(r"/api/camera-stream/([\d.]+)/(video\d+)\.(mjpg|jpg)", self.path)
        if m:
            return self.proxy(*m.groups())
        super().do_GET()

    def do_PUT(self):
        if self.path != "/api/camera":
            return self.json({"error": "not found"}, 404)
        try:
            choice = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            assert isinstance(choice, dict) and choice.get("kind") in ("none", "local", "remote")
        except (ValueError, AssertionError):
            return self.json({"error": "expected {kind: none|local|remote, ...}"}, 400)
        CHOICE.write_text(json.dumps(choice, indent=2) + "\n")
        self.json(choice)

    def proxy(self, ip, cam, ext):
        # only cameras on this host or tailnet peers, never an arbitrary address
        if ip not in {h[1] for h in tailnet_hosts()}:
            return self.json({"error": "not a tailnet host"}, 403)
        kind = "stream" if ext == "mjpg" else "snapshot"
        try:
            upstream = urllib.request.urlopen(f"http://{ip}:{CAMERA_PORT}/{kind}/{cam}.{ext}", timeout=5)
        except OSError as e:
            return self.json({"error": str(e)}, 502)
        with upstream:
            self.send_response(200)
            self.send_header("Content-Type", upstream.headers["Content-Type"])
            self.end_headers()
            try:
                while chunk := upstream.read1(65536):
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(
    (os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8765"))),
    functools.partial(Handler, directory=str(ROOT)),
).serve_forever()
