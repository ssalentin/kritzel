"""Upper-left UI: idle pill hidden, camera state only in the frame, build queue in the panel style.

    python3 -m unittest scripts/test_panels.py

Real server + headless viewer in a temp world, with /api/status and /api/action answered by a
fake pipeline so the build queue and a status note can be shown without a camera or generator.
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
SHOTS = {
    "idle-1440": Path("/tmp/ui-panels-idle-1440.png"),
    "build-1440": Path("/tmp/ui-panels-build-1440.png"),
    "note-1440": Path("/tmp/ui-panels-note-1440.png"),
    "frame-1440": Path("/tmp/ui-panels-frame-1440.png"),
    "idle-390": Path("/tmp/ui-panels-idle-390.png"),
    "build-390": Path("/tmp/ui-panels-build-390.png"),
    "note-390": Path("/tmp/ui-panels-note-390.png"),
}

STATUS = {
    "now": 1000,
    "capture": {"alive": True, "state": "camera-off"},
    "generate": {
        "alive": True, "state": "building", "since": 995,
        "now": {"de": "Laterne", "en": "lantern"},
        "things": [
            {"name": {"de": "Laterne", "en": "lantern"}, "file": "laterne.js", "state": "building"},
            {"name": {"de": "Hexe", "en": "witch"}, "file": "hexe.js", "state": "listed"},
        ],
    },
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Panels(unittest.TestCase):
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
        cls.port = free_port()
        cls.server = subprocess.Popen([sys.executable, str(cls.world / "viewer" / "serve.py")], cwd=cls.world,
                                      env={**os.environ, "PORT": str(cls.port)}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/viewer/", timeout=0.5).read()
                break
            except OSError:
                if cls.server.poll() is not None:
                    raise RuntimeError("serve.py did not start: " + cls.server.stderr.read()[-500:])
                time.sleep(0.1)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, args=["--no-sandbox", "--use-angle=swiftshader",
                                                                  "--enable-unsafe-swiftshader"])
        cls.page = cls.browser.new_page(viewport={"width": 1440, "height": 900})
        cls.errors = []
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/", wait_until="load")
        cls.page.wait_for_function("() => window.__paperWorld?.()?.feet", timeout=30000)
        time.sleep(3)

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

    def shot(self, name):
        try:
            self.page.screenshot(path=str(SHOTS[name]), timeout=120000)
        except Exception:
            print(f"({name} screenshot skipped: software renderer too slow)")

    def serve_status(self):
        self.page.route("**/api/status", lambda route: route.fulfill(json=STATUS))
        self.page.reload()
        self.page.wait_for_function("() => window.__paperWorld?.()?.feet", timeout=30000)
        time.sleep(3)

    def check_layout(self):
        state = self.page.evaluate("""() => {
          const s = document.getElementById('status'), b = document.getElementById('bq');
          const cs = getComputedStyle(s), cb = getComputedStyle(b), r = b.getBoundingClientRect(), sr = s.getBoundingClientRect();
          const fr = document.getElementById('frame').getBoundingClientRect();
          const hit = (a, b) => !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
          return { status: { display: cs.display, text: s.textContent.trim() }, bq: { display: cb.display, bg: cb.backgroundColor,
            radius: cb.borderRadius, transform: cb.transform, rows: b.querySelectorAll('.row').length, rect: [r.left, r.top, r.right, r.bottom] },
            statusRect: [sr.left, sr.top, sr.right, sr.bottom], overlap: hit(sr, r), frameOverlap: hit(sr, fr) };
        }""")
        self.assertEqual(state["bq"]["rows"], 2, state)
        self.assertEqual(state["bq"]["radius"], "10px", state)
        self.assertNotEqual(state["bq"]["transform"], "matrix(1, 0, 0, 1, 0, 0)", state)
        self.assertEqual(state["bq"]["bg"], "rgba(255, 255, 255, 0.78)", state)
        self.assertFalse(state["overlap"], state)
        self.assertFalse(state["frameOverlap"], state)
        return state

    def test_panels(self):
        # (a) camera off, idle: the top-left is empty and the frame is the camera indicator
        idle = self.page.evaluate("""() => {
          const s = document.getElementById('status'), f = document.getElementById('frame');
          return { display: getComputedStyle(s).display, text: s.textContent.trim(), frame: f.textContent };
        }""")
        self.assertEqual(idle["display"], "none", idle)
        self.assertIn("Kamera", idle["frame"], idle)
        self.shot("idle-1440")
        # (d) the camera frame is the single camera indicator
        try:
            self.page.locator("#frame").screenshot(path=str(SHOTS["frame-1440"]), timeout=120000)
        except Exception:
            print("(frame screenshot skipped: software renderer too slow)")

        # (b) a fake build with two rows
        self.serve_status()
        built = self.check_layout()
        self.assertEqual(built["status"]["display"], "flex", built)
        self.shot("build-1440")

        # (c) a status note on top of the build
        self.page.route("**/api/action", lambda route: route.fulfill(json={"ok": True, "command": {"kind": "unknown", "why": "Das kann ich noch nicht."}}))
        self.page.click('#textMode button[data-mode="action"]')
        self.page.fill("#textThingIn", "Mach die Welt bunt")
        self.page.click("#textThing button.go")
        time.sleep(1.2)
        note = self.page.evaluate("""() => ({ text: document.querySelector('#status .note').textContent,
          hidden: document.querySelector('#status .note').hidden, tone: document.querySelector('#status .note').dataset.tone })""")
        self.assertFalse(note["hidden"], note)
        self.assertEqual(note["tone"], "bad", note)
        self.check_layout()
        self.shot("note-1440")

        # phone
        self.page.set_viewport_size({"width": 390, "height": 844})
        time.sleep(0.5)
        self.page.evaluate("() => { document.querySelector('#status .note').hidden = true; }")
        time.sleep(0.3)
        self.check_layout()
        self.shot("build-390")
        self.page.evaluate("() => { document.querySelector('#status .note').hidden = false; }")
        time.sleep(0.2)
        self.check_layout()
        self.shot("note-390")
        idle_phone = self.page.evaluate("""() => { const s = document.getElementById('status'); return getComputedStyle(s).display; }""")
        self.assertEqual(idle_phone, "flex", "the note keeps the pill visible on the phone")
        # idle again: remove the route and the note by a new page? the build fake stays; hide the note and clear things
        self.page.evaluate("() => { const n = document.querySelector('#status .note'); n.hidden = true; }")
        self.page.unroute("**/api/status")
        self.page.reload()
        self.page.wait_for_function("() => window.__paperWorld?.()?.feet", timeout=30000)
        time.sleep(2)
        self.shot("idle-390")
        self.assertEqual(self.page.evaluate("() => getComputedStyle(document.getElementById('status')).display"), "none")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
