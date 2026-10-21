"""The 3D | Pixel switch, per-thing claude-pxl renderer and world snapshot.

    python3 -m unittest scripts/test_pixel.py

Real serve.py and headless viewer in a temp world. One thing gets a custom PNG and the others use
the committed archetypes; the test stubs the online rebuild and checks the authored scene too.
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
SHOT_3D = Path("/tmp/kritzel-pixel-back-3d.png")

THING = """export const meta = {{ name: '{name}', drawing: '{drawing}', paper: {{ x: {x}, y: {y} }} }};
export function build({{ THREE, world, mat }}) {{
  const g = new THREE.Group(), m = new THREE.Mesh(new THREE.SphereGeometry(.35, 12, 8), mat(0x6fa8dc));
  m.position.y = .35; g.add(m); g.position.set({bx}, 0, {bz}); world.add(g);
  return {{ obstacles: [{{ x: {bx}, z: {bz}, r: .3 }}] }};
}}
"""


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
        (cls.world / "viewer" / "things").mkdir()
        (cls.world / "scripts").mkdir()
        shutil.copy(ROOT / "scripts" / "pixel-world.mjs", cls.world / "scripts" / "pixel-world.mjs")
        things = [
            ("gelbe-blume.js", "Gelbe Blume", "a yellow flower", .55, .34, .8, -1.9),
            ("gelbe-blume-2.js", "Gelbe Blume 2", "a yellow flower", .64, .39, 2.3, -1.3),
            ("kritzelwesen.js", "Kritzelwesen", "a scribble creature", .43, .65, -1.1, 1.7),
            ("kritzel.js", "Kritzel", "a scribble ball", .71, .7, 3.5, 2.4),
        ]
        for file, name, drawing, x, y, bx, bz in things:
            (cls.world / "viewer" / "things" / file).write_text(
                THING.format(name=name, drawing=drawing, x=x, y=y, bx=bx, bz=bz))
        sprite_dir = cls.world / "viewer" / "pixel" / "sprites"
        shutil.copy(sprite_dir / "fallback-tree.png", sprite_dir / "kritzel.png")
        future = time.time() + 30
        pixel = cls.world / "viewer" / "pixel"
        for png in [*pixel.glob("scenes/*.png"), *pixel.glob("sprites/*.png")]:
            os.utime(png, (future, future))
        scene = pixel / "scenes" / "kritzel.png"
        cls.scene_bytes = scene.read_bytes()
        cls.port = free_port()
        cls.server = subprocess.Popen([sys.executable, str(cls.world / "viewer" / "serve.py")], cwd=cls.world,
                                      env={**os.environ, "PORT": str(cls.port)}, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/viewer/", timeout=.5).read()
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
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/?seed=7", wait_until="load")
        cls.page.wait_for_function("() => window.__paperWorld?.()?.pixelSnapshot", timeout=30000)
        time.sleep(20)

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

    def test_1_authored_scene_is_320x200_nearest_neighbour(self):
        self.assertEqual(self.scene_bytes[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", self.scene_bytes[16:24]), (320, 200))
        stale = self.api("/api/pixel-world", {})
        self.assertEqual(stale["built"], False, stale)
        saved = self.api("/api/pixel-snapshot", {"things": [{"name": "Nur die Probe"}]})
        self.assertTrue(saved["ok"], saved)
        self.assertGreater(saved["bytes"], 0, saved)
        self.assertEqual(self.api("/api/pixel-snapshot")["things"][0]["name"], "Nur die Probe")

    def test_2_switch_snapshot_persistence_and_back(self):
        self.assertEqual(self.page.locator('#renderMode button[data-mode="3d"]').get_attribute("aria-pressed"), "true")
        self.page.click('#renderMode button[data-mode="pixel"]')
        self.page.wait_for_url("**/viewer/pixel/", timeout=30000)
        self.page.wait_for_function("() => window.__pixelApp?.ready", timeout=30000)
        self.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
        time.sleep(1)
        state = self.page.evaluate("""() => ({
          key: sessionStorage.getItem('kritzelPixelMode'),
          smooth: document.querySelector('#scene').getContext('2d').imageSmoothingEnabled,
          pixel: document.querySelector('#renderMode button[data-mode="pixel"]').getAttribute('aria-pressed'),
          snapshot: window.__pixelSnapshot,
          items: window.__pixelApp.items.map(i => ({name: i.name, kind: i.kind, source: i.source})),
          canvas: document.querySelector('#scene').getBoundingClientRect().toJSON(),
          group: document.querySelector('#renderMode').getBoundingClientRect().toJSON(),
        })""")
        self.assertEqual(state["key"], "1")
        self.assertFalse(state["smooth"])
        self.assertEqual(state["pixel"], "true")
        self.assertEqual(sorted(t["name"] for t in state["snapshot"]["things"]),
                         sorted(["Gelbe Blume", "Gelbe Blume 2", "Kritzelwesen", "Kritzel"]))
        custom = next(i for i in state["items"] if i["name"] == "Kritzel")
        self.assertEqual(custom["source"], "thing")
        flower = next(i for i in state["items"] if i["name"] == "Gelbe Blume")
        self.assertEqual((flower["kind"], flower["source"]), ("flower", "fallback"))
        self.assertLessEqual(state["group"]["right"], 1600)
        self.page.screenshot(path=str(SHOT_DESKTOP), timeout=120000)
        self.page.reload(wait_until="load")
        self.page.wait_for_function("() => window.__pixelApp?.ready", timeout=30000)
        self.assertTrue(self.page.url.endswith("/viewer/pixel/"))
        self.page.click('#renderMode button[data-mode="3d"]')
        self.page.wait_for_function("() => location.pathname.endsWith('/viewer/')", timeout=30000)
        self.page.wait_for_function("() => window.__paperWorld?.()?.feet", timeout=30000)
        self.assertEqual(self.page.evaluate("() => __paperWorld().feet().length"), 4)
        self.assertEqual(self.page.evaluate("() => sessionStorage.getItem('kritzelPixelMode')"), "0")
        self.assertEqual(self.page.locator('#renderMode button[data-mode="3d"]').get_attribute("aria-pressed"), "true")
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.page.evaluate("() => window.__render()")
        self.page.screenshot(path=str(SHOT_3D), timeout=120000)
        self.page.click('#renderMode button[data-mode="pixel"]')
        self.page.wait_for_url("**/viewer/pixel/", timeout=30000)
        self.page.wait_for_function("() => window.__pixelApp?.ready", timeout=30000)
        self.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
        self.page.screenshot(path=str(SHOT_PHONE), timeout=120000)
        phone = self.page.evaluate("() => document.querySelector('#renderMode').getBoundingClientRect().toJSON()")
        self.assertLessEqual(phone["right"], 390)
        self.assertGreaterEqual(phone["left"], 0)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
