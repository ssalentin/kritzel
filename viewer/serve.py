"""Serve the camera folder on localhost:8765 with caching disabled,
so the viewer always picks up the latest world.js and camera frames.

Camera selection (see scripts/camera_server.py for the remote side):
  GET /api/cameras              → remote cameras found on online Tailscale peers (and this host)
  GET /api/camera-stream/<ip>/<id>.mjpg|.jpg → that camera, proxied (same origin, works under https);
                                  ?small asks for the camera server's small preview
  GET/PUT /api/camera           → the chosen camera, kept in camera.json for the capture stage
  GET /api/status               → what capture and generate are doing (frames/status/*.json), for the status pill
  GET /api/status/cutout.png    → the newest drawing as a paper cut-out (written by capture)
  GET/PUT /api/mode             → the world mode, {mode: add | switch}, in viewer/things/mode.json
  GET  /api/changelog           → the latest commits (newest first), for the viewer's "what's new"
  POST /api/newworld            → runs scripts/newworld.sh: archive this world to worlds/, start an empty one
  GET /api/stamps               → mtime:size of every engine file and every thing, so the viewer's poll is one request
  PUT /api/placement            → {file, d: [dx, dz] | null}: where the viewer moved a new thing (viewer/things/placement.json)

HOST / PORT env vars change the listen address (default 127.0.0.1:8765).
"""
import base64
import functools
import hashlib
import http.server
import json
import os
import re
import subprocess
import threading
import time
import posixpath
import socket
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHOICE = ROOT / "camera.json"


def version():
    """Read per request: live code is merged in without restarting this server."""
    v = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "dev"
    try:
        c = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        c = ""
    return {"version": v, "commit": c}
def changelog(n=60):
    """What changed lately, newest first: the commits of the running checkout (merges left out)."""
    try:
        # merges are left out, but a release tag (v0.2.0) can sit on a merge: list tags separately and attach
        # each to the newest listed commit it contains
        out = subprocess.run(["git", "log", "--no-merges", f"-n{n}", "--format=%h%x09%cI%x09%s"], cwd=ROOT,
                             capture_output=True, text=True, timeout=3).stdout
        tags = subprocess.run(["git", "tag", "--list", "v*", "--sort=-creatordate", "--format=%(refname:short)%09%(objectname:short)"],
                              cwd=ROOT, capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    items = [dict(zip(("commit", "date", "subject"), l.split("\t", 2))) for l in out.splitlines() if l.count("\t") >= 2]
    for line in tags.splitlines():
        tag, at = (line.split("\t") + [""])[:2]
        for it in items:          # newest first: the first listed commit that is in the tag's history
            r = subprocess.run(["git", "merge-base", "--is-ancestor", it["commit"], at], cwd=ROOT, capture_output=True, timeout=3)
            if r.returncode == 0:
                it.setdefault("version", tag)
                break
    return items
CAMERA_PORT = int(os.environ.get("CAMERA_PORT", "8766"))   # where camera_server.py (or replay_camera.py) listens
STATUS = ROOT / "frames" / "status"
PLACEMENT_LOCK = threading.Lock()
SITUATION = ROOT / "frames" / "status" / "situation.json"   # what the sim reports for the dialogue writer (PUT /api/situation)
MODE_FILE = ROOT / "viewer" / "things" / "mode.json"     # {"mode": "add" | "switch"}; missing = add (issue #16)
NEWWORLD_LOCK, NEWWORLD_GAP_S = threading.Lock(), 10
last_newworld = [0.0]


def read_mode():
    try:
        m = json.loads(MODE_FILE.read_text()).get("mode")
    except (OSError, ValueError, AttributeError):
        m = None
    return m if m in ("add", "switch") else "add"
ALIVE_S = 10          # a stage whose status file is older than this is not running


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


def public(path):
    """Only the viewer, archived worlds and the camera server script are served; never .git,
    private notes or camera.json (this server is reachable on the tailnet)."""
    path = posixpath.normpath(urllib.parse.unquote(path))
    if any(part.startswith(".") for part in path.split("/")):
        return False
    return path in ("/viewer", "/worlds", "/scripts/camera_server.py") or path.startswith(("/viewer/", "/worlds/"))


def clean_choice(c):
    """Keep only known fields of a camera choice; a remote one must name a camera on a tailnet host."""
    kind = c.get("kind")
    if kind == "none":
        return {"kind": "none"}
    if kind == "local":
        return {"kind": "local", "label": str(c.get("label") or "")[:200]}
    hosts = dict((ip, name) for name, ip in tailnet_hosts())
    assert kind == "remote" and c.get("ip") in hosts and re.fullmatch(r"video\d+", str(c.get("id")))
    return {"kind": "remote", "ip": c["ip"], "id": c["id"], "host": hosts[c["ip"]], "name": str(c.get("name") or c["id"])[:200],
            "stream": f"/api/camera-stream/{c['ip']}/{c['id']}.mjpg"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Content-Security-Policy", self.csp())
        super().end_headers()

    # things/*.js are written by a model from a camera picture anyone can draw on, and they run in
    # this page. The policy keeps whatever they do inside it: code only from here, the page's own
    # inline scripts (by hash) and the two pinned CDN packages; requests and images only to here.
    CDN = "https://cdn.jsdelivr.net/npm/three@0.160.0/ https://cdn.jsdelivr.net/npm/rot-js@2.2.1/"

    def csp(self):
        hashes = ""
        try:
            f = Path(self.translate_path(self.path))
            f = f / "index.html" if f.is_dir() else f
            if f.suffix == ".html":
                for script in re.findall(r"<script[^>]*>(.*?)</script>", f.read_text(), re.S):
                    hashes += " 'sha256-%s'" % base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        except OSError:
            pass
        return (f"default-src 'self'; script-src 'self'{hashes} {self.CDN}; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; "
                "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'")

    def json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/version":
            return self.json(version())
        if path == "/api/changelog":
            return self.json(changelog())
        if path == "/api/cameras":
            hosts = tailnet_hosts()
            with ThreadPoolExecutor(16) as ex:
                return self.json([c for cams in ex.map(probe, hosts) for c in cams])
        if path == "/api/camera":
            try:
                return self.json(json.loads(CHOICE.read_text()))
            except (OSError, ValueError):
                return self.json(None)
        if path == "/api/stamps":
            def stamps(folder, pattern):
                out = {}
                for f in folder.glob(pattern):
                    try:
                        st = f.stat()
                        out[f.name] = f"{st.st_mtime_ns}:{st.st_size}"
                    except OSError:
                        pass
                return out
            viewer = ROOT / "viewer"
            return self.json({"engine": {**stamps(viewer, "*.js"), **stamps(viewer, "*.html")},
                              "things": stamps(viewer / "things", "*.js")})
        if path == "/api/mode":
            return self.json({"mode": read_mode()})
        if path == "/api/status":
            return self.json(self.status())
        if path == "/api/status/cutout.png":
            try:
                body = (STATUS / "cutout.png").read_bytes()
            except OSError:
                return self.json({"error": "not found"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        m = re.fullmatch(r"/api/camera-stream/([\d.]+)/(video\d+)\.(mjpg|jpg)", path)
        if m:
            small = "small" in urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True)
            return self.proxy(*m.groups(), small)
        if not public(path):
            return self.json({"error": "not found"}, 404)
        super().do_GET()

    def status(self):
        now, out = time.time(), {"now": time.time()}
        for stage in ("capture", "generate"):
            try:
                st = json.loads((STATUS / f"{stage}.json").read_text())
                assert isinstance(st, dict)
            except (OSError, ValueError, AssertionError):
                st = {}
            st["alive"] = isinstance(st.get("beat"), (int, float)) and now - st["beat"] < ALIVE_S
            out[stage] = st
        out["mode"] = read_mode()
        return out

    def do_HEAD(self):
        if not public(urllib.parse.urlsplit(self.path).path):
            return self.json({"error": "not found"}, 404)
        super().do_HEAD()

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path != "/api/newworld":
            return self.json({"error": "not found"}, 404)
        # only the viewer itself: a page on another site can send a plain POST without asking first,
        # but not one with this header (that needs a CORS preflight, which we never grant)
        if self.headers.get("X-Kritzel") != "1":
            return self.json({"error": "forbidden"}, 403)
        # a new world: scripts/newworld.sh archives this one to worlds/ (never deletes) and empties things/
        with NEWWORLD_LOCK:
            if time.time() - last_newworld[0] < NEWWORLD_GAP_S:
                return self.json({"error": "a new world was just started"}, 429)
            try:
                r = subprocess.run([str(ROOT / "scripts" / "newworld.sh")], capture_output=True, text=True, timeout=30)
            except (OSError, subprocess.SubprocessError) as e:
                return self.json({"error": str(e)[:200]}, 500)
            if r.returncode:
                return self.json({"error": (r.stderr or r.stdout)[-300:]}, 500)
            last_newworld[0] = time.time()
        return self.json({"archived": r.stdout.strip().split("worlds/")[-1]})

    def do_PUT(self):
        if urllib.parse.urlsplit(self.path).path == "/api/placement":
            return self.placement()
        if urllib.parse.urlsplit(self.path).path == "/api/situation":
            # what the sim reports: who carries what, what is in the air, the night, the weather. Small and checked
            # (a viewer on the page writes it; the dialogue writer reads it from frames/status/situation.json)
            try:
                n = int(self.headers.get("Content-Length", ""))
                assert 0 <= n <= 4096
                body = json.loads(self.rfile.read(n))
                assert isinstance(body, dict)
                situ = {
                    "carrying": [{"who": str(x["who"])[:80], "what": str(x["what"])[:80]} for x in body.get("carrying", [])[:8]],
                    "thrown": [{"who": str(x["who"])[:80], "what": str(x["what"])[:80], "to": str(x["to"])[:80]} for x in body.get("thrown", [])[:8]],
                    "night": min(1.0, max(0.0, float(body.get("night", 0)))),
                    "weather": [str(k)[:20] for k in body.get("weather", [])[:6]],
                    "at": time.time(),
                }
            except (ValueError, AssertionError, KeyError, TypeError):
                return self.json({"error": "expected {carrying, thrown, night, weather}"}, 400)
            SITUATION.parent.mkdir(parents=True, exist_ok=True)
            tmp = SITUATION.with_name(".situation.json.tmp")
            tmp.write_text(json.dumps(situ) + "\n")
            tmp.replace(SITUATION)
            return self.json(situ)
        if urllib.parse.urlsplit(self.path).path == "/api/mode":
            try:
                n = int(self.headers.get("Content-Length", ""))
                assert 0 <= n <= 64
                mode = json.loads(self.rfile.read(n))["mode"]
                assert mode in ("add", "switch")
            except (ValueError, AssertionError, KeyError, TypeError):
                return self.json({"error": "expected {mode: add | switch}"}, 400)
            tmp = MODE_FILE.with_name(".mode.json.tmp")
            tmp.write_text(json.dumps({"mode": mode}) + "\n")
            tmp.replace(MODE_FILE)
            return self.json({"mode": mode})
        if urllib.parse.urlsplit(self.path).path != "/api/camera":
            return self.json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length", ""))
            assert 0 <= n <= 4096
            choice = clean_choice(json.loads(self.rfile.read(n)))
        except (ValueError, AssertionError, TypeError, AttributeError):
            return self.json({"error": "expected {kind: none} | {kind: local, label} | {kind: remote, ip, id}"}, 400)
        CHOICE.write_text(json.dumps(choice, indent=2) + "\n")
        self.json(choice)

    def placement(self):
        """The first viewer to place a new thing decides; later ones and reloads read the same spot."""
        try:
            n = int(self.headers.get("Content-Length", ""))
            assert 0 <= n <= 512
            req = json.loads(self.rfile.read(n))
            file, d, force = req["file"], req.get("d"), req.get("force") is True
            assert re.fullmatch(r"[\w.-]+\.js", file)
            assert d is None or (isinstance(d, list) and len(d) == 2 and all(isinstance(v, (int, float)) and abs(v) < 20 for v in d))
        except (ValueError, AssertionError, KeyError, TypeError):
            return self.json({"error": "expected {file: name.js, d: [dx, dz] | null}"}, 400)
        things = ROOT / "viewer" / "things"
        path = things / "placement.json"
        with PLACEMENT_LOCK:
            try:
                placed = json.loads(path.read_text())
            except (OSError, ValueError):
                # first placement in this world: everything already standing stays where it is
                placed = {f.name: [0, 0] for f in things.glob("*.js") if f.name != file}
            placed = {f: v for f, v in placed.items() if (things / f).exists() or f == file}   # gone things free their name
            if d is None:
                placed.pop(file, None)
            elif (force or file not in placed) and len(placed) < 500:   # force: the engine pulled two things apart
                placed[file] = d
            tmp = path.with_name(".placement.json.tmp")
            tmp.write_text(json.dumps(placed, indent=1))
            tmp.replace(path)
        self.json(placed.get(file))

    def proxy(self, ip, cam, ext, small=False):
        # only cameras on this host or tailnet peers, never an arbitrary address
        if ip not in {h[1] for h in tailnet_hosts()}:
            return self.json({"error": "not a tailnet host"}, 403)
        kind = "stream" if ext == "mjpg" else "snapshot"
        try:
            # longer than the camera server's own 5 s wait for a first frame, so its reason gets through
            upstream = urllib.request.urlopen(f"http://{ip}:{CAMERA_PORT}/{kind}/{cam}.{ext}{'?small' if small else ''}",
                                              timeout=10)
        except urllib.error.HTTPError as e:
            return self.json({"error": e.read().decode(errors="replace")[:300] or str(e)}, 502)
        except OSError as e:
            return self.json({"error": str(e)}, 502)
        with upstream:
            self.send_response(200)
            self.send_header("Content-Type", upstream.headers["Content-Type"] if kind == "snapshot"
                             else "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            try:
                if kind == "snapshot":
                    while chunk := upstream.read1(65536):
                        self.wfile.write(chunk)
                else:
                    self.relay_latest(upstream)
            except OSError:
                pass

    def relay_latest(self, upstream):
        """Pass a camera stream on frame by frame, always the newest: when the viewer's side is
        slower than the camera's, frames are skipped instead of piling up in buffers as lag."""
        latest, cond, done = [None, 0], threading.Condition(), threading.Event()

        def read():
            buf = b""
            try:
                while not done.is_set() and (chunk := upstream.read1(65536)):
                    buf += chunk
                    while (end := buf.find(b"\xff\xd9")) != -1:
                        start = buf.find(b"\xff\xd8")
                        if 0 <= start < end:
                            with cond:
                                latest[:] = buf[start:end + 2], latest[1] + 1
                                cond.notify()
                        buf = buf[end + 2:]
                    if len(buf) > 8 << 20:  # no frame end in 8 MB: not a camera stream
                        break
            except Exception:             # includes the response being closed under it
                pass
            with cond:
                done.set()
                cond.notify()

        threading.Thread(target=read, daemon=True).start()
        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 64 << 10)
        seq = 0
        try:
            while True:
                with cond:
                    cond.wait_for(lambda: latest[1] != seq or done.is_set(), 10)
                    if latest[1] == seq:
                        return            # upstream ended or went quiet
                    frame, seq = latest
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(frame))
                self.wfile.write(frame + b"\r\n")
        finally:
            done.set()                    # the reader stops at its next chunk; `with upstream` closes it

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(
    (os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8765"))),
    functools.partial(Handler, directory=str(ROOT)),
).serve_forever()
