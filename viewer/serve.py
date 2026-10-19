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
  GET  /api/think               → {on, model}: is the Jev director switched on (KRITZEL_THINK=1 and a key)?
  POST /api/think               → {scene, actors} → {goals, usage, ms}: a local director; {} when it is off or fails

HOST / PORT env vars change the listen address (default 127.0.0.1:8765).
"""
import base64
import functools
import hashlib
import http.server
import json
import math
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
CHANGELOG_CACHE = {}      # HEAD sha -> items: the tag walk below costs seconds on a big checkout, the answer changes only with HEAD


def changelog(n=60):
    """What changed lately, newest first: the commits of the running checkout (merges left out)."""
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        head = ""
    if head and head in CHANGELOG_CACHE:
        return CHANGELOG_CACHE[head]
    items = changelog_walk(n)
    if head and items:
        CHANGELOG_CACHE.clear(); CHANGELOG_CACHE[head] = items
    return items


def changelog_walk(n):
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
SITUATION_LEASE = {"client": None, "at": 0.0}
SITUATION_LEASE_S = 60
SITUATION = ROOT / "frames" / "status" / "situation.json"   # what the sim reports for the dialogue writer (PUT /api/situation)
MODE_FILE = ROOT / "viewer" / "things" / "mode.json"     # {"mode": "add" | "switch"}; missing = add (issue #16)
NEWWORLD_LOCK, NEWWORLD_GAP_S = threading.Lock(), 10
last_newworld = [0.0]

# ---------- the Jev director: a slow, server-side opinion on what a figure should do next ----------
# The sim still decides every goal locally at 60 fps. Every few seconds it asks this proxy for one
# Choice per figure; a failed, slow or switched-off answer simply leaves the local decision in charge.
THINK_URL = "https://openrouter.ai/api/alpha/decisions"   # overridable for tests (KRITZEL_THINK_URL)
THINK_MODEL = "typesafe/jev-1.14"
THINK_TIMEOUT_S = 2.0
THINK_CACHE_S = 3.0
THINK_MAX_ACTORS = 8
THINK_LOCK = threading.Lock()                 # at most one upstream request in flight
THINK_CACHE = {}                              # payload hash → (at, answer), at most THINK_CACHE_S old
THINK_GOALS = {
    "explore": "Wander somewhere else on the pages, curious about the book",
    "greet": "Go over to another figure and say hello",
    "chat": "Go over to another figure for a chat",
    "play": "Go over to another figure to play",
    "eat": "Find something to eat (a drawn food spot, an egg)",
    "rest": "Sit down or sleep for a while",
    "hide": "Get out of the way: into a drawn door if there is one, otherwise away from the others",
    "follow": "Walk after a figure it likes or follows",
    "inspect": "Go and look at a drawn thing nearby",
    "dance": "Dance, preferably with another figure",
}


def think_enabled():
    """Off unless asked for and a key is present: the local sim is the default."""
    on = os.environ.get("KRITZEL_THINK", "0").strip().lower()
    return on not in ("", "0", "false", "off", "no") and bool(os.environ.get("OPENROUTER_API_KEY", "").strip())


def think_config():
    return {"on": think_enabled(), "model": os.environ.get("KRITZEL_THINK_MODEL", THINK_MODEL)}


def _text(x, n=80):
    return str(x)[:n] if isinstance(x, (str, int, float)) else ""


def _distance(x):
    try:
        d = float(x)
    except (TypeError, ValueError):
        return None
    return round(d, 1) if math.isfinite(d) and d >= 0 else None


def _cost(x):
    try:
        c = float(x)
    except (TypeError, ValueError):
        return None
    return round(c, 8) if math.isfinite(c) and c >= 0 else None


def clean_think(body):
    """The compact state the sim sends, checked and bounded before it reaches an external service."""
    if not isinstance(body, dict) or not isinstance(body.get("actors"), list):
        return None
    actors = []
    for a in body["actors"][:THINK_MAX_ACTORS]:
        if not isinstance(a, dict):
            continue
        aid = _text(a.get("id"), 60)
        if not aid:
            continue
        nearby = []
        for t in (a.get("nearby") if isinstance(a.get("nearby"), list) else [])[:3]:
            if not isinstance(t, dict) or not _text(t.get("name"), 60):
                continue
            d = _distance(t.get("distance"))
            if d is None:
                continue
            nearby.append({"name": _text(t.get("name"), 60), "kind": _text(t.get("kind"), 20), "distance": d})
        actors.append({
            "id": aid,
            "name": _text(a.get("name"), 40) or aid,
            "kind": _text(a.get("kind"), 20) or "figure",
            "mood": _text(a.get("mood"), 20) or "calm",
            "needs": [_text(n, 30) for n in (a.get("needs") if isinstance(a.get("needs"), list) else [])[:3] if _text(n)],
            "nearby": nearby,
        })
    if not actors:
        return None
    scene = body.get("scene") if isinstance(body.get("scene"), dict) else {}
    night = scene.get("night")
    try:
        night = min(1.0, max(0.0, float(night)))
    except (TypeError, ValueError):
        night = 0.0
    weather = [_text(w, 20) for w in (scene.get("weather") if isinstance(scene.get("weather"), list) else [])[:6] if _text(w)]
    return {"scene": {"night": round(night, 2), "weather": weather}, "actors": actors}


def think_payload(state):
    """One Choice per figure, all evaluated in parallel in one request (TypeSafe's documented pattern)."""
    questions = {}
    for a in state["actors"]:
        needs = ", ".join(a["needs"]) or "nothing pressing"
        near = ", ".join(f"{t['name']} ({t['distance']} m away)" for t in a["nearby"]) or "nothing close"
        questions[a["id"]] = {
            "type": "choice",
            "instructions": {
                "figure": f"{a['name']} ({a['kind']}), mood: {a['mood']}, needs: {needs}. Nearby: {near}.",
                "question": f"What should {a['name']} do next in this book world? Pick the one action that fits best.",
            },
            "criteria": THINK_GOALS,
        }
    return {"model": os.environ.get("KRITZEL_THINK_MODEL", THINK_MODEL), "state": state, "questions": questions}


def think_answers(upstream, wanted):
    """Jev's answers → {actor id: {goal, confidence}}; anything unexpected is left out."""
    goals = {}
    answers = upstream.get("answers") if isinstance(upstream, dict) else None
    if not isinstance(answers, dict):
        return goals
    for aid, ans in answers.items():
        aid = _text(aid, 60)
        choice = ans.get("choice") if isinstance(ans, dict) else None
        if aid not in wanted or not isinstance(choice, str) or choice not in THINK_GOALS:
            continue
        try:
            confidence = round(float(ans.get("confidence", 0)), 3)
        except (TypeError, ValueError):
            confidence = 0.0
        goals[aid] = {"goal": choice, "confidence": confidence}
    return goals


def think(body):
    """The proxy. Anything that goes wrong answers {} — the sim keeps its own local choice."""
    if not think_enabled():
        return {}
    state = clean_think(body)
    if not state:
        return {}
    payload = think_payload(state)
    key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    now = time.time()
    hit = THINK_CACHE.get(key)
    if hit and now - hit[0] < THINK_CACHE_S:
        return hit[1]
    if not THINK_LOCK.acquire(blocking=False):
        return {}                                  # one request at a time; a second viewer keeps its local pick
    try:
        started = time.time()
        req = urllib.request.Request(
            os.environ.get("KRITZEL_THINK_URL", THINK_URL),
            data=json.dumps(payload).encode(),
            method="POST",
            headers={"Authorization": "Bearer " + os.environ.get("OPENROUTER_API_KEY", ""),
                     "Content-Type": "application/json",
                     "X-Title": "Kritzel director"},
        )
        try:
            with urllib.request.urlopen(req, timeout=THINK_TIMEOUT_S) as r:
                upstream = json.load(r)
        except (OSError, ValueError, urllib.error.HTTPError):
            return {}
        goals = think_answers(upstream, {a["id"] for a in state["actors"]})
        if not goals:
            return {}
        usage = upstream.get("usage") if isinstance(upstream.get("usage"), dict) else {}
        cost = _cost(usage.get("cost"))
        out = {"goals": goals, "usage": {"cost": cost, "input_tokens": usage.get("input_tokens"),
                                         "output_tokens": usage.get("output_tokens")},
               "ms": round((time.time() - started) * 1000)}
        if len(THINK_CACHE) >= 8:
            for k in [k for k, v in THINK_CACHE.items() if time.time() - v[0] >= THINK_CACHE_S]:
                THINK_CACHE.pop(k, None)
            if len(THINK_CACHE) >= 8:
                THINK_CACHE.pop(next(iter(THINK_CACHE)))
        THINK_CACHE[key] = (time.time(), out)
        return out
    finally:
        THINK_LOCK.release()


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


def solved_entries(items):
    """Quests solved lately, { who, at }: a bad entry is dropped, the rest of the report still counts."""
    out = []
    for x in items[:8] if isinstance(items, list) else []:
        try:
            out.append({"who": str(x["who"])[:80], "at": float(x["at"])})
        except (KeyError, TypeError, ValueError):
            continue
    return out


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
        if path == "/api/think":
            return self.json(think_config())
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
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/think":
            # same header as /api/newworld: a page on another site must not spend credits by a plain POST
            if self.headers.get("X-Kritzel") != "1":
                return self.json({"error": "forbidden"}, 403)
            try:
                n = int(self.headers.get("Content-Length", ""))
                assert 0 <= n <= 16384
                body = json.loads(self.rfile.read(n))
            except (ValueError, AssertionError, TypeError):
                return self.json({})
            try:
                return self.json(think(body))
            except Exception:                    # the contract is {} on any failure, never a dropped request
                return self.json({})
        if path != "/api/newworld":
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
                    "solved": solved_entries(body.get("solved", [])),
                    "at": time.time(),
                }
                client = str(body.get("client", ""))[:40]
                assert client
            except (ValueError, AssertionError, KeyError, TypeError):
                return self.json({"error": "expected {client, carrying, thrown, night, weather}"}, 400)
            # one reporter at a time: the first viewer to report holds the lease, renewed by each report; it lapses
            # after SITUATION_LEASE_S silent, so a closed or hidden viewer hands over. Reports from others are refused.
            now = time.time()
            if SITUATION_LEASE["client"] not in (None, client) and now - SITUATION_LEASE["at"] < SITUATION_LEASE_S:
                return self.json({"error": "another viewer reports the situation"}, 409)
            SITUATION_LEASE.update(client=client, at=now)
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
                # first placement in this world: nothing is placed yet. The viewer places every thing of a world
                # without a placement.json by its paper place, so the others must not be pinned at [0, 0] here
                placed = {}
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


def main():
    http.server.ThreadingHTTPServer(
        (os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8765"))),
        functools.partial(Handler, directory=str(ROOT)),
    ).serve_forever()


if __name__ == "__main__":
    main()
