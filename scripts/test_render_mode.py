"""3D and Pixel own separate worlds; switching archives and empties without mixing.

    python3 -m unittest scripts/test_render_mode.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOT_CONFIRM = Path("/tmp/render-mode-confirm.png")
SHOT_EMPTY_PIXEL = Path("/tmp/render-mode-empty-pixel.png")
SHOT_PIXEL_THING = Path("/tmp/render-mode-pixel-thing.png")
SHOT_3D_THING = Path("/tmp/render-mode-3d-thing.png")

FIGUR = """export const meta = { name: 'Mira', drawing: 'a person', paper: { x: 0.4, y: 0.6 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x6a8fd0, hairColor: 0x4a3020 });
  return { actors: [{ id: 'mira', name: 'Mira', start: [1, 1], rig }] };
}
"""
PIXEL_THING = {"name": "Drache", "drawing": "a green dragon", "kind": "dragon",
               "paper": {"x": .6, "y": .55}, "sprite": "drache.png"}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RenderMode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright is not installed")
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, args=["--no-sandbox", "--use-angle=swiftshader",
                                                                  "--enable-unsafe-swiftshader"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.world = Path(self.tmp.name) / "world"
        shutil.copytree(ROOT / "viewer", self.world / "viewer", ignore=shutil.ignore_patterns("__pycache__", "things"))
        self.pixel = self.world / "viewer" / "pixel"
        (self.world / "viewer" / "things").mkdir()
        (self.pixel / "things").mkdir(exist_ok=True)
        (self.world / "scripts").mkdir()
        shutil.copy(ROOT / "scripts" / "newworld.sh", self.world / "scripts" / "newworld.sh")
        (self.world / "viewer" / "things" / "figur.js").write_text(FIGUR)
        (self.pixel / "things" / "drache.json").write_text(json.dumps(PIXEL_THING))
        shutil.copy(self.pixel / "sprites" / "fallback-dragon.png", self.pixel / "things" / "drache.png")
        (self.world / "world-mode.json").write_text('{"render":"3d"}\n')
        self.port = free_port()
        self.server = subprocess.Popen([sys.executable, str(self.world / "viewer" / "serve.py")], cwd=self.world,
                                       env={**os.environ, "PORT": str(self.port)}, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/viewer/", timeout=.5).read()
                break
            except OSError:
                if self.server.poll() is not None:
                    raise RuntimeError("serve.py did not start: " + self.server.stderr.read()[-500:])
                time.sleep(.1)
        self.page = self.browser.new_page(viewport={"width": 1440, "height": 900})
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))

    def tearDown(self):
        self.page.close()
        self.server.terminate()
        try:
            self.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.server.kill()
        self.tmp.cleanup()

    def archives(self):
        return sorted((self.world / "worlds").iterdir())

    def size(self, path):
        p = Path(path)
        return sum(1 for _ in p.iterdir()) if p.is_dir() else 0

    def files(self, path, suffix):
        p = Path(path)
        return list(p.glob("*" + suffix)) if p.is_dir() else []

    def test_switch_to_pixel_archives_and_starts_empty(self):
        self.page.goto(f"http://127.0.0.1:{self.port}/viewer/", wait_until="load")
        self.page.wait_for_function("() => window.__paperWorld?.()?.feet", timeout=30000)
        pixel = self.page.locator('#renderMode button[data-mode="pixel"]')
        pixel.click()
        self.assertIn(pixel.text_content(), {"Sicher? Nochmal tippen", "Sure? Tap again"})
        self.assertEqual(self.size(self.world / "worlds") if (self.world / "worlds").exists() else 0, 0)
        self.assertTrue((self.world / "viewer" / "things" / "figur.js").exists())
        self.page.screenshot(path=str(SHOT_CONFIRM), timeout=120000)
        pixel.click()
        self.page.wait_for_function("() => location.pathname === '/viewer/pixel/'", timeout=30000)
        self.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
        self.assertEqual(json.loads((self.world / "world-mode.json").read_text())["render"], "pixel")
        self.assertEqual(self.files(self.world / "viewer" / "things", ".js"), [])
        self.assertEqual(self.files(self.pixel / "things", ".json"), [])
        archive = self.archives()[0]
        self.assertEqual(json.loads((archive / "world-mode.json").read_text())["render"], "3d")
        self.assertTrue((archive / "things" / "figur.js").exists())
        self.assertTrue((archive / "pixel" / "things" / "drache.json").exists())
        self.assertEqual(self.page.evaluate("() => window.__pixelApp.items.length"), 0)
        self.page.screenshot(path=str(SHOT_EMPTY_PIXEL), timeout=120000)
        self.page.goto(f"http://127.0.0.1:{self.port}/worlds/{archive.name}/pixel/", wait_until="load")
        self.page.wait_for_function("(p) => location.pathname === p", arg=f"/worlds/{archive.name}/", timeout=30000)
        self.assertEqual(self.errors, [])

        # A pixel-side pipeline result appears in the new, empty mode without touching 3D files.
        self.page.goto(f"http://127.0.0.1:{self.port}/viewer/pixel/", wait_until="load")
        self.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
        self.assertEqual(self.page.evaluate("() => window.__pixelThings?.length"), 0)
        (self.pixel / "things" / "neu.json").write_text(json.dumps({**PIXEL_THING, "name": "Neuer Drache"}))
        shutil.copy(self.pixel / "sprites" / "fallback-dragon.png", self.pixel / "things" / "neu.png")
        self.page.wait_for_function("() => window.__pixelThings?.length === 1", timeout=30000)
        self.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
        self.assertEqual(self.page.evaluate("() => window.__pixelApp.items[0].name"), "Neuer Drache")
        self.page.screenshot(path=str(SHOT_PIXEL_THING), timeout=120000)

    def test_direct_live_pixel_route_redirects_in_3d_mode(self):
        self.page.goto(f"http://127.0.0.1:{self.port}/viewer/pixel/", wait_until="load")
        self.page.wait_for_function("() => location.pathname === '/viewer/'", timeout=30000)
        self.page.wait_for_function("() => window.__paperWorld?.()?.feet", timeout=30000)

    def test_switch_back_archives_pixel_and_archived_page_reopens_pixel(self):
        (self.world / "world-mode.json").write_text('{"render":"pixel"}\n')
        self.page.goto(f"http://127.0.0.1:{self.port}/viewer/pixel/", wait_until="load")
        self.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
        three = self.page.locator('#renderMode button[data-mode="3d"]')
        three.click()
        self.assertIn(three.text_content(), {"Sicher? Nochmal tippen", "Sure? Tap again"})
        three.click()
        self.page.wait_for_function("() => location.pathname === '/viewer/'", timeout=30000)
        self.page.wait_for_function("() => window.__paperWorld?.()?.feet", timeout=30000)
        self.assertEqual(json.loads((self.world / "world-mode.json").read_text())["render"], "3d")
        self.assertEqual(self.files(self.world / "viewer" / "things", ".js"), [])
        self.assertEqual(self.files(self.pixel / "things", ".json"), [])
        archive = self.archives()[0]
        self.assertEqual(json.loads((archive / "world-mode.json").read_text())["render"], "pixel")
        self.assertTrue((archive / "pixel" / "things" / "drache.json").exists())
        self.assertTrue((archive / "pixel" / "things" / "drache.png").exists())

        self.page.goto(f"http://127.0.0.1:{self.port}/worlds/{archive.name}/", wait_until="load")
        self.page.wait_for_function("() => location.pathname.endsWith('/pixel/')", timeout=30000)
        try:
            self.page.wait_for_function("() => window.__pixelApp?.dynamic", timeout=30000)
        except Exception:
            print(self.page.evaluate("""() => ({path: location.pathname, things: window.__pixelThings,
              items: window.__pixelApp?.items, ready: window.__pixelApp?.ready, dynamic: window.__pixelApp?.dynamic})"""))
            raise
        self.assertEqual(self.page.evaluate("() => window.__pixelApp.items[0].name"), "Drache")
        self.assertEqual(self.errors, [])

        # A new 3D result belongs only to viewer/things.
        (self.world / "viewer" / "things" / "neu.js").write_text(FIGUR)
        self.page.goto(f"http://127.0.0.1:{self.port}/viewer/", wait_until="load")
        self.page.wait_for_function("() => window.__paperWorld?.()?.feet?.().length === 1", timeout=30000)
        time.sleep(2)
        self.page.screenshot(path=str(SHOT_3D_THING), timeout=120000)
        self.assertEqual(self.files(self.pixel / "things", ".json"), [])

    def test_failed_switch_leaves_the_world_and_mode_intact(self):
        (self.world / "scripts" / "newworld.sh").write_text("#!/usr/bin/env bash\nexit 7\n")
        os.chmod(self.world / "scripts" / "newworld.sh", 0o755)
        self.page.goto(f"http://127.0.0.1:{self.port}/viewer/", wait_until="load")
        self.page.wait_for_function("() => window.__paperWorld?.()?.feet", timeout=30000)
        pixel = self.page.locator('#renderMode button[data-mode="pixel"]')
        pixel.click(); pixel.click()
        self.page.wait_for_function("() => !document.querySelector('#renderMode button[data-mode=\"pixel\"]').disabled", timeout=30000)
        self.assertEqual(self.page.evaluate("() => location.pathname"), "/viewer/")
        said = self.page.evaluate("""() => ({text: document.querySelector('#status .note').textContent,
          hidden: document.querySelector('#status .note').hidden})""")
        self.assertFalse(said["hidden"], said)
        self.assertIn(said["text"], {"Der Wechsel hat nicht geklappt. Die Welt bleibt.",
                                    "The switch did not work. The world stays."})
        self.assertTrue((self.world / "viewer" / "things" / "figur.js").exists())
        self.assertTrue((self.pixel / "things" / "drache.json").exists())
        self.assertEqual(json.loads((self.world / "world-mode.json").read_text())["render"], "3d")
        self.assertFalse((self.world / "worlds").exists() and any((self.world / "worlds").iterdir()))


if __name__ == "__main__":
    unittest.main()
