"""The pixel surface reads only viewer/pixel/things JSON and sprites.

    python3 -m unittest scripts/test_pixel.py

Real serve.py and headless Chromium in a temp pixel-mode world.
"""
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOT_DESKTOP = Path("/tmp/kritzel-pixel-1600.png")
SHOT_PHONE = Path("/tmp/kritzel-pixel-390.png")
SHOT_MOVED = Path("/tmp/kritzel-pixel-moved.png")
SHOT_REACT = Path("/tmp/kritzel-pixel-react.png")
SHOT_REACT_ALT = Path("/tmp/kritzel-pixel-react-bob.png")
MOVIE = Path("/tmp/kritzel-pixel-live.gif")
GREET_MOVIE = Path("/tmp/kritzel-pixel-greet.gif")
PHYSICS_MOVIE = Path("/tmp/kritzel-pixel-physics.gif")
SHOT_PHYSICS_FINAL = Path("/tmp/kritzel-pixel-physics-final.png")
THROW_MOVIE = Path("/tmp/kritzel-pixel-throw.gif")

THINGS = [
    {"file": "gelbe-blume.json", "name": "Gelbe Blume", "drawing": "a yellow flower",
     "kind": "scenery", "paper": {"x": .55, "y": .34}, "sprite": "gelbe-blume.png"},
    {"file": "gelbe-blume-2.json", "name": "Gelbe Blume 2", "drawing": "a yellow flower",
     "kind": "scenery", "paper": {"x": .64, "y": .39}, "sprite": "gelbe-blume-2.png"},
    {"file": "laeufer.json", "name": "Läufer", "drawing": "a girl walking across the book",
     "kind": "actor", "paper": {"x": .43, "y": .65}, "sprite": "laeufer.png"},
    {"file": "kritzel.json", "name": "Kritzel", "drawing": "a scribble ball",
     "kind": "actor", "move": "fly", "paper": {"x": .71, "y": .7}, "sprite": "kritzel.png"},
    {"file": "truhe.json", "name": "Truhe", "drawing": "a small wooden chest",
     "kind": "scenery", "portable": True, "paper": {"x": .55, "y": .62}, "sprite": "truhe.png"},
    {"file": "baum.json", "name": "Baum", "drawing": "a tall tree",
     "kind": "scenery", "portable": False, "paper": {"x": .2, "y": .4}, "sprite": "baum.png"},
]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Pixel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright is not installed")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.world = Path(cls.tmp.name) / "world"
        shutil.copytree(ROOT / "viewer", cls.world / "viewer", ignore=shutil.ignore_patterns("__pycache__", "things"))
        pixel = cls.world / "viewer" / "pixel"
        (cls.world / "viewer" / "things").mkdir()
        (pixel / "things").mkdir()
        (cls.world / "scripts").mkdir()
        shutil.copy(ROOT / "scripts" / "pixel-world.mjs", cls.world / "scripts" / "pixel-world.mjs")
        for thing in THINGS:
            (pixel / "things" / thing["file"]).write_text(json.dumps(thing))
        shutil.copy(pixel / "sprites" / "fallback-tree.png", pixel / "things" / "kritzel.png")
        if not (pixel / "scenes" / "kritzel.png").exists():
            shutil.copy(pixel / "scenes" / "book.png", pixel / "scenes" / "kritzel.png")
        (cls.world / "world-mode.json").write_text('{"render":"pixel"}\n')
        future = time.time() + 30
        for png in [*pixel.glob("scenes/*.png"), *pixel.glob("sprites/*.png")]:
            os.utime(png, (future, future))
        cls.scene_bytes = (pixel / "scenes" / "kritzel.png").read_bytes()
        cls.port = free_port()
        cls.server = subprocess.Popen([sys.executable, str(cls.world / "viewer" / "serve.py")], cwd=cls.world,
                                      env={**os.environ, "PORT": str(cls.port)}, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/viewer/pixel/", timeout=.5).read()
                break
            except OSError:
                if cls.server.poll() is not None:
                    raise RuntimeError("serve.py did not start: " + cls.server.stderr.read()[-500:])
                time.sleep(.1)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, args=["--no-sandbox", "--use-angle=swiftshader",
                                                                  "--enable-unsafe-swiftshader"])
        cls.page = cls.browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1.5)
        cls.errors = []
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))
        cls.page.route("**/api/pixel-world",
                       lambda route: route.fulfill(json={"ok": True, "built": False, "bytes": len(cls.scene_bytes)}))
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/pixel/", wait_until="load")
        try:
            cls.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
        except Exception:
            print("page errors:", cls.errors)
            print(cls.page.evaluate("() => ({text: document.body.textContent, app: !!window.__pixelApp})"))
            raise
        time.sleep(1)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.terminate()
        try:
            cls.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
        cls.tmp.cleanup()

    def api(self, path, body=None):
        headers = {"Content-Type": "application/json"}
        if body is not None:
            headers["X-Kritzel"] = "1"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        return json.loads(urllib.request.urlopen(req, timeout=5).read())

    def test_1_authored_scene_and_pixel_thing_api(self):
        self.assertEqual(self.scene_bytes[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", self.scene_bytes[16:24]), (320, 200))
        stale = self.api("/api/pixel-world", {})
        self.assertEqual(stale["built"], False, stale)
        payload = self.api("/api/pixel-things")
        things = payload["things"]
        self.assertRegex(payload["version"], r"^[0-9a-f]{20}$")
        self.assertEqual(sorted(t["name"] for t in things), sorted(t["name"] for t in THINGS))
        self.assertEqual(next(t for t in things if t["name"] == "Kritzel")["move"], "fly")
        self.assertEqual(self.api("/api/world-mode"), {"render": "pixel"})

    def test_2_pixel_renderer_and_confirm_reset(self):
        state = self.page.evaluate("""() => ({
          smooth: document.querySelector('#scene').getContext('2d').imageSmoothingEnabled,
          things: window.__pixelThings,
          items: window.__pixelApp.items.map(i => ({name: i.name, kind: i.kind, form: i.form, source: i.source,
            frames: i.frames, portable: i.portable})),
          pixel: document.querySelector('#renderMode button[data-mode="pixel"]').getAttribute('aria-pressed'),
          group: document.querySelector('#renderMode').getBoundingClientRect().toJSON(),
        })""")
        self.assertFalse(state["smooth"])
        self.assertEqual(state["pixel"], "true")
        custom = next(i for i in state["items"] if i["name"] == "Kritzel")
        self.assertEqual(custom["source"], "thing")
        walker = next(i for i in state["items"] if i["name"] == "Läufer")
        self.assertEqual(walker["source"], "fallback-strip")
        self.assertEqual(walker["frames"], 4)
        chest = next(i for i in state["items"] if i["name"] == "Truhe")
        self.assertTrue(chest["portable"])
        flower = next(i for i in state["items"] if i["name"] == "Gelbe Blume")
        self.assertEqual((flower["kind"], flower["form"], flower["source"]), ("scenery", "flower", "fallback"))
        self.assertLessEqual(state["group"]["right"], 1600)
        self.page.screenshot(path=str(SHOT_DESKTOP), timeout=120000)

        other = self.page.locator('#renderMode button[data-mode="3d"]')
        other.click()
        self.assertIn(other.text_content(), {"Sicher? Nochmal tippen", "Sure? Tap again"})
        self.assertTrue(self.page.url.endswith("/viewer/pixel/"))
        self.page.locator('#renderMode button[data-mode="pixel"]').click()
        self.assertEqual(other.text_content(), "3D")

        self.page.set_viewport_size({"width": 390, "height": 844})
        self.page.screenshot(path=str(SHOT_PHONE), timeout=120000)
        group = self.page.evaluate("() => document.querySelector('#renderMode').getBoundingClientRect().toJSON()")
        self.assertLessEqual(group["right"], 390)
        self.assertGreaterEqual(group["left"], 0)
        self.assertEqual(self.errors, [])

    def test_3_figures_move_and_a_tap_reacts(self):
        self.page.set_viewport_size({"width": 1440, "height": 900})
        time.sleep(.3)
        before = self.page.evaluate("() => window.__pixelApp.actors.map(a => ({id: a.id, mover: a.mover, x: a.x, y: a.y}))")
        self.assertEqual(sorted(a["mover"] for a in before), ["fly", "walk"])
        frames = []
        for i in range(12):
            shot = Path(f"/tmp/kritzel-pixel-motion-{i:02d}.png")
            self.page.screenshot(path=str(shot), timeout=120000)
            frames.append(shot)
            time.sleep(.25)
        after = self.page.evaluate("() => window.__pixelApp.actors.map(a => ({id: a.id, mover: a.mover, x: a.x, y: a.y}))")
        for old, new in zip(before, after):
            self.assertGreater(abs(new["x"] - old["x"]) + abs(new["y"] - old["y"]), .4, (old, new))
        self.page.screenshot(path=str(SHOT_MOVED), timeout=120000)
        subprocess.run(["convert", "-delay", "25", "-loop", "0", *map(str, frames),
                        "-resize", "720x450", str(MOVIE)], check=True)

        point = self.page.evaluate("""() => {
          const a = window.__pixelApp.actors.find(x => x.mover === 'walk'), c = document.querySelector('#scene');
          const r = c.getBoundingClientRect(), s = Math.min(r.width / 320, r.height / 200);
          return {x: r.left + (r.width - 320 * s) / 2 + a.x * s,
                  y: r.top + (r.height - 200 * s) / 2 + (a.y - 8) * s, ax: a.x, ay: a.y};
        }""")
        self.page.mouse.click(point["x"], point["y"])
        time.sleep(.1)
        card = self.page.evaluate("""() => ({hidden: document.querySelector('#actorCard').hidden,
          text: document.querySelector('#actorCard').textContent,
          state: window.__pixelApp.actors.find(x => x.mover === 'walk').state})""")
        self.assertFalse(card["hidden"], card)
        self.assertIn("Läufer", card["text"])
        self.assertEqual(card["state"], "greet")
        self.page.screenshot(path=str(SHOT_REACT), timeout=120000)
        time.sleep(.13)
        self.page.screenshot(path=str(SHOT_REACT_ALT), timeout=120000)
        subprocess.run(["convert", "-delay", "13", "-loop", "0", str(SHOT_REACT), str(SHOT_REACT_ALT),
                        "-resize", "720x450", str(GREET_MOVIE)], check=True)
        time.sleep(2)
        resumed = self.page.evaluate("""() => {
          const a = window.__pixelApp.actors.find(x => x.mover === 'walk');
          return {state: a.state, x: a.x, y: a.y};
        }""")
        self.assertIn(resumed["state"], {"idle", "move"})
        self.assertGreater(abs(resumed["x"] - point["ax"]) + abs(resumed["y"] - point["ay"]), .3, resumed)

    def test_4_physics_push_and_throw(self):
        self.page.set_viewport_size({"width": 1440, "height": 900})
        self.page.evaluate("""() => {
          const app = window.__pixelApp, p = window.__pixelPhysics;
          const actor = app.actors.find(a => a.mover === 'walk');
          const chest = app.items.find(i => i.name === 'Truhe');
          const flower = app.items.find(i => i.name === 'Gelbe Blume');
          p.place(chest, 90, 130); p.place(flower, 90, 92);
          actor.x = 55; actor.y = 130; actor.pause = 0; actor.target = {x: 100, y: 130};
        }""")
        before = self.page.evaluate("""() => {
          const chest = window.__pixelApp.items.find(i => i.name === 'Truhe');
          const b = window.__pixelPhysics.portableBodies.get(chest); return {x: b.position.x, y: b.position.y};
        }""")
        shots = []
        for i in range(4):
            shot = Path(f"/tmp/kritzel-pixel-physics-{i}.png")
            self.page.screenshot(path=str(shot), timeout=120000)
            shots.append(shot)
            time.sleep(.25)
        after = self.page.evaluate("""() => {
          const chest = window.__pixelApp.items.find(i => i.name === 'Truhe');
          const b = window.__pixelPhysics.portableBodies.get(chest); return {x: b.position.x, y: b.position.y};
        }""")
        self.assertGreater(after["x"], before["x"] + .5, (before, after))

        point = self.page.evaluate("""() => {
          const item = window.__pixelApp.items.find(i => i.name === 'Gelbe Blume');
          const chest = window.__pixelApp.items.find(i => i.name === 'Truhe');
          window.__pixelPhysics.place(item, 90, 92); window.__pixelPhysics.place(chest, 135, 92);
          const b = window.__pixelPhysics.portableBodies.get(item), c = document.querySelector('#scene');
          const r = c.getBoundingClientRect(), s = Math.min(r.width / 320, r.height / 200);
          return {x: r.left + (r.width - 320 * s) / 2 + b.position.x * s,
                  y: r.top + (r.height - 200 * s) / 2 + b.position.y * s};
        }""")
        self.page.mouse.move(point["x"], point["y"]); self.page.mouse.down()
        for n in range(1, 6):
            self.page.mouse.move(point["x"] + n * 20, point["y"])
            self.page.wait_for_timeout(25)
        self.page.mouse.up()
        throw_shots = []
        for i in range(5):
            shot = Path(f"/tmp/kritzel-pixel-throw-{i}.png")
            self.page.screenshot(path=str(shot), timeout=120000)
            throw_shots.append(shot)
            time.sleep(.1)
        thrown = self.page.evaluate("""() => {
          const item = window.__pixelApp.items.find(i => i.name === 'Gelbe Blume');
          const chest = window.__pixelApp.items.find(i => i.name === 'Truhe');
          const a = window.__pixelPhysics.portableBodies.get(item), b = window.__pixelPhysics.portableBodies.get(chest);
          return {x: a.position.x, speed: a.speed, chestX: b.position.x, gap: b.position.x - a.position.x};
        }""")
        self.assertGreater(thrown["x"], 90.5, thrown)
        self.assertGreater(abs(thrown["gap"]), 18, thrown)
        self.assertLess(thrown["speed"], 8, thrown)
        self.page.screenshot(path=str(SHOT_PHYSICS_FINAL), timeout=120000)
        subprocess.run(["convert", "-delay", "25", "-loop", "0", *map(str, shots + [SHOT_PHYSICS_FINAL]),
                        "-resize", "720x450", str(PHYSICS_MOVIE)], check=True)
        subprocess.run(["convert", "-delay", "10", "-loop", "0", *map(str, throw_shots),
                        "-resize", "720x450", str(THROW_MOVIE)], check=True)


if __name__ == "__main__":
    unittest.main()
