"""The New World button: sticky confirm, a visible wait, a clear refusal, and a page turn with sound.

    python3 -m unittest scripts/test_new_world.py

Real serve.py + headless viewer in a temp world with one drawn thing. The failure path stubs
POST /api/newworld; the success path archives the temp world for real.
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
SHOT_ARMED = Path("/tmp/kritzel-new-world-armed.png")
SHOT_FAILED = Path("/tmp/kritzel-new-world-failed.png")

FIGUR = """export const meta = { name: 'Mira', drawing: 'a person', paper: { x: 0.4, y: 0.6 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x6a8fd0, hairColor: 0x4a3020 });
  return { actors: [{ id: 'mira', name: 'Mira', start: [1, 1], rig }] };
}
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class NewWorld(unittest.TestCase):
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
        (cls.world / "viewer" / "things" / "figur.js").write_text(FIGUR)
        (cls.world / "scripts").mkdir()
        shutil.copy(ROOT / "scripts" / "newworld.sh", cls.world / "scripts" / "newworld.sh")
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
                                                                  "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
        cls.page = cls.browser.new_page(viewport={"width": 1000, "height": 700})
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

    def label(self):
        return self.page.evaluate("() => ({ text: newBtn.textContent, disabled: newBtn.disabled })")

    def note(self):
        return self.page.evaluate("() => ({ text: document.querySelector('#status .note').textContent, hidden: document.querySelector('#status .note').hidden })")

    def test_a_failure_is_visible_and_keeps_the_world(self):
        self.page.click("#newBtn")
        time.sleep(0.3)
        first = self.label()
        self.assertRegex(first["text"], r"Sicher|Sure", first)
        time.sleep(5)
        self.assertEqual(self.label()["text"], first["text"], "the confirm must stay armed while the child thinks")
        self.page.evaluate("() => window.__render()")
        try:
            self.page.screenshot(path=str(SHOT_ARMED), timeout=120000)
        except Exception:
            print("(armed screenshot skipped: software renderer too slow)")

        # a pending fetch in the page, so the wait state is observable (a Playwright route handler runs on this thread)
        self.page.evaluate("""() => {
          window.__realFetch = window.fetch;
          window.fetch = (url, opts) => String(url).includes('/api/newworld')
            ? new Promise(res => setTimeout(() => res(new Response(JSON.stringify({ error: 'qa failure' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } })), 1200))
            : window.__realFetch(url, opts);
        }""")
        self.page.click("#newBtn")
        time.sleep(0.3)
        busy = self.label()
        self.assertRegex(busy["text"], r"Blättert|Turning", busy)
        self.assertTrue(busy["disabled"], busy)
        self.assertFalse(self.note()["hidden"], "the wait must be visible in the pill")
        time.sleep(1.5)
        failed = self.label()
        self.assertFalse(failed["disabled"], failed)
        self.assertRegex(failed["text"], r"Neue Welt|New world", failed)
        said = self.note()
        self.assertFalse(said["hidden"], said)
        self.assertRegex(said["text"], r"nicht geklappt|did not work", said)
        self.assertEqual(self.page.evaluate("() => __paperWorld().feet().length"), 1)
        self.page.evaluate("() => window.__render()")
        try:
            self.page.screenshot(path=str(SHOT_FAILED), timeout=120000)
        except Exception:
            print("(failure screenshot skipped: software renderer too slow)")
        self.page.evaluate("() => { window.fetch = window.__realFetch; }")

    def test_the_page_turns_with_the_new_world_sound(self):
        self.page.click("#snd")
        for _ in range(40):
            time.sleep(0.3)
            if len(self.page.evaluate("() => __paperSound.bankLoaded()")) == 9:
                break
        self.page.click("#newBtn")
        time.sleep(0.2)
        self.page.click("#newBtn")
        for _ in range(40):
            time.sleep(0.3)
            if self.page.evaluate("() => __paperWorld().feet().length") == 0:
                break
        time.sleep(1.0)
        self.assertEqual(self.page.evaluate("() => __paperWorld().feet().length"), 0)
        last = self.page.evaluate("() => __paperSound.lastPlay()")
        self.assertIn(last["role"], {"newWorld", "pageTurn"}, last)
        self.assertTrue(self.note()["hidden"], "the wait note goes away when the page turns")
        archive = sorted((self.world / "worlds").iterdir())[-1]
        self.assertTrue((archive / "pixel" / "index.html").is_file(), archive)
        self.assertTrue((archive / "pixel" / "scenes" / "kritzel.png").is_file(), archive)
        self.assertEqual(json.loads((archive / "world-mode.json").read_text())["render"], "3d")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
