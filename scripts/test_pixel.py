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

THINGS = [
    {"file": "gelbe-blume.json", "name": "Gelbe Blume", "drawing": "a yellow flower",
     "kind": "scenery", "paper": {"x": .55, "y": .34}, "sprite": "gelbe-blume.png"},
    {"file": "gelbe-blume-2.json", "name": "Gelbe Blume 2", "drawing": "a yellow flower",
     "kind": "scenery", "paper": {"x": .64, "y": .39}, "sprite": "gelbe-blume-2.png"},
    {"file": "laeufer.json", "name": "Läufer", "drawing": "a girl walking across the book",
     "kind": "actor", "paper": {"x": .43, "y": .65}, "sprite": "laeufer.png"},
    {"file": "kritzel.json", "name": "Kritzel", "drawing": "a scribble ball",
     "kind": "actor", "move": "fly", "paper": {"x": .71, "y": .7}, "sprite": "kritzel.png"},
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
        cls.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
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
          items: window.__pixelApp.items.map(i => ({name: i.name, kind: i.kind, form: i.form, source: i.source, frames: i.frames})),
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


if __name__ == "__main__":
    unittest.main()
