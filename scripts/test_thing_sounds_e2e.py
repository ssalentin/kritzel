"""End to end: a thing's own Ogg plays on arrival and tap; a thing without one keeps the generic sound.

    python3 -m unittest scripts/test_thing_sounds_e2e.py

A private copy of the viewer, a real serve.py, and headless Chromium (Playwright). The dragon's
Ogg is a copy of the bank's tap sound (this tests playback, not the DSP, which test_thing_sounds.py
renders); the stone has no Ogg. No sound may play or be fetched before the first click.
"""
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

THING = """export const meta = {{ name: '{name}', drawing: 'a small test shape', paper: {{ x: 0.4, y: 0.6 }} }};
export function build({{ THREE, world, mat }}) {{
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), mat(0x{color})));
  world.add(g);
  return {{ actors: [], obstacles: [], spots: [] }};
}}
"""

HEXE = """export const meta = { name: 'Hexe', drawing: 'a witch', paper: { x: 0.7, y: 0.4 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x5a3a7a });
  return { actors: [{ id: 'hexe', name: 'Hexe', start: [2, 1], rig, move: 'walk' }] };
}
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Things(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright is not installed")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.world = Path(cls.tmp.name) / "world"
        shutil.copytree(ROOT / "viewer", cls.world / "viewer",
                        ignore=shutil.ignore_patterns("__pycache__", "things"))
        cls.things = cls.world / "viewer" / "things"
        cls.things.mkdir()
        cls.sounds = cls.world / "viewer" / "sounds" / "things"
        cls.sounds.mkdir(parents=True)
        (cls.things / "drache.js").write_text(THING.format(name="Drache", color="cc6644"))
        (cls.things / "stein.js").write_text(THING.format(name="Stein", color="999999"))
        (cls.things / "hexe.js").write_text(HEXE)
        shutil.copyfile(ROOT / "viewer" / "sounds" / "tap.ogg", cls.sounds / "drache.ogg")
        shutil.copyfile(ROOT / "viewer" / "sounds" / "tap.ogg", cls.sounds / "hexe.ogg")
        cls.port = free_port()
        cls.server = subprocess.Popen([sys.executable, str(cls.world / "viewer" / "serve.py")],
                                      cwd=cls.world, env={**os.environ, "PORT": str(cls.port)},
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/viewer/", timeout=0.5).read()
                break
            except OSError:
                if cls.server.poll() is not None:
                    raise RuntimeError("serve.py did not start: " + cls.server.stderr.read()[-500:])
                time.sleep(0.1)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, args=[
            "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
            "--autoplay-policy=no-user-gesture-required"])
        cls.page = cls.browser.new_page(viewport={"width": 900, "height": 650})
        cls.requests = []
        cls.errors = []
        cls.page.on("request", lambda r: cls.requests.append(r.url) if "sounds/things" in r.url else None)
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/?seed=7&cam=12,7,14,0,0.4,0")
        cls.page.wait_for_function("() => window.__paperSound && window.__paperWorld?.()?.things?.().length === 3",
                                   timeout=30000)

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

    def test_nothing_before_the_first_click_then_each_thing_its_sound(self):
        self.assertEqual(self.page.evaluate("() => window.__paperSound.lastPlay()"), None)
        self.assertEqual(self.requests, [], "a thing sound was fetched before the first click")

        self.page.click("#snd")
        self.page.wait_for_function("() => window.__paperSound.enabled", timeout=10000)
        self.page.evaluate("() => window.__paperSound.prepareThing('drache.js')")
        self.page.wait_for_function("() => window.__paperSound.thingSound('drache')?.buf", timeout=10000)

        # a character is tapped through who.rig.g (index.html); rig.g/free carry the thing's file
        self.page.wait_for_function("() => window.__paperWorld().rig('hexe.js')", timeout=10000)
        self.page.evaluate("() => window.__paperSound.prepareThing('hexe.js')")
        self.page.wait_for_function("() => window.__paperSound.thingSound('hexe')?.buf", timeout=10000)
        self.page.evaluate("() => window.__paperSound.fx('tap', window.__paperWorld().rig('hexe.js'))")
        tap = self.page.evaluate("() => window.__paperSound.lastPlay()")
        self.assertEqual((tap["role"], tap["file"], tap["targetRole"]), ("thing", "hexe", "tap"))

        # a new thing that arrives with its Ogg plays it (the real arrival call site in index.html)
        shutil.copyfile(ROOT / "viewer" / "sounds" / "tap.ogg", self.sounds / "drache2.ogg")
        (self.things / "drache2.js").write_text(THING.format(name="Drache Zwei", color="aa4444"))
        self.page.wait_for_function("() => window.__paperWorld().box('drache2.js')", timeout=15000)
        self.page.wait_for_function("() => window.__paperSound.lastPlay()?.file === 'drache2'", timeout=10000)
        self.assertEqual(self.page.evaluate("() => window.__paperSound.lastPlay().targetRole"), "arrival")

        # tapping it plays the same Ogg with the tap role
        self.page.evaluate("() => window.__paperWorld().tapThing(window.__paperWorld().box('drache2.js'))")
        self.page.wait_for_function("() => window.__paperSound.lastPlay()?.targetRole === 'tap'", timeout=5000)

        # a rewritten thing gets its new Ogg: forget the old buffer on reload, then fetch/decode again
        old_duration = self.page.evaluate("() => window.__paperSound.thingSound('drache2').buf.duration")
        self.page.evaluate("() => { window.__oldBox = window.__paperWorld().box('drache2.js'); }")
        shutil.copyfile(ROOT / "viewer" / "sounds" / "giggle.ogg", self.sounds / "drache2.ogg")
        (self.things / "drache2.js").write_text(THING.format(name="Drache Zwei", color="aa4444") + "\n// rewritten\n")
        self.page.wait_for_function("() => window.__paperWorld().box('drache2.js') !== window.__oldBox", timeout=15000)
        self.page.wait_for_function(
            "(old) => { const b = window.__paperSound.thingSound('drache2')?.buf; return !!b && b.duration !== old; }",
            arg=old_duration, timeout=10000)
        new_duration = self.page.evaluate("() => window.__paperSound.thingSound('drache2').buf.duration")
        self.assertNotEqual(new_duration, old_duration)

        # a new thing without an Ogg falls back to today's arrival and tap bank sounds
        (self.things / "stein2.js").write_text(THING.format(name="Stein Zwei", color="777777"))
        self.page.wait_for_function("() => window.__paperWorld().box('stein2.js')", timeout=15000)
        self.page.wait_for_function("() => window.__paperSound.lastPlay()?.role === 'arrival'", timeout=10000)
        self.assertNotEqual(self.page.evaluate("() => window.__paperSound.lastPlay().file"), "stein2")
        self.page.evaluate("() => window.__paperWorld().tapThing(window.__paperWorld().box('stein2.js'))")
        self.page.wait_for_function("() => window.__paperSound.lastPlay()?.role === 'tap'", timeout=5000)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
