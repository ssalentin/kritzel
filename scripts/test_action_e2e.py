"""End to end: type an action, watch the local world change.

    python3 -m unittest scripts/test_action_e2e.py

Real serve.py + headless viewer + fake Jev. The fake sees the instruction text and answers the six
Choices; the server assembles the command and the page applies it through window.__applyAction.
Checks snow, night, a witch flying to the moon, and an unsupported sentence that only changes the
pill. Screenshots are bounded and optional.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOT_SNOW = Path("/tmp/kritzel-action-snow.png")
SHOT_FLIGHT = Path("/tmp/kritzel-action-flight.png")
SHOT_UNKNOWN = Path("/tmp/kritzel-action-unknown.png")

HEXE = """export const meta = { name: 'Hexe', drawing: 'a witch on a broom', paper: { x: 0.3, y: 0.65 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x5a3a7a, hairColor: 0x2a2a2a });
  return { actors: [{ id: 'hexe', name: 'Hexe', start: [-3, 2], rig, move: 'fly' }] };
}
"""

MOND = """export const meta = { name: 'Mond', drawing: 'a round moon in the sky', paper: { x: 0.5, y: 0.2 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group();
  const moon = new THREE.Mesh(new THREE.SphereGeometry(0.8, 18, 14), mat(0xffe27a, { emissive: 0xffc94a, emissiveIntensity: 0.5 }));
  g.add(moon);
  g.position.set(0, 6, -3);
  world.add(g);
  return { update(t) { g.position.y = 6 + Math.sin(t * 0.8) * 0.1; } };
}
"""

EULE = """export const meta = { name: 'Eule', drawing: 'an owl', paper: { x: 0.7, y: 0.7 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x8a6a3a, hairColor: 0x5a4a2a });
  return { actors: [{ id: 'eule', name: 'Eule', start: [2, 1], rig }] };
}
"""


class Upstream(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n))
        text = (body.get("state") or {}).get("instruction", "")
        if "schneien" in text:
            ans = {"kind": "weather", "weather": "snow"}
        elif "Nacht" in text:
            ans = {"kind": "time", "time": "night"}
        elif "Mond soll tanzen" in text:
            ans = {"kind": "goal", "action": "dance", "target": "mond.js", "where": "none"}
        elif "Mond" in text:
            ans = {"kind": "goal", "action": "fly_to", "target": "hexe.js", "where": "mond.js"}
        elif "tanzen" in text:
            ans = {"kind": "goal", "action": "dance", "target": "hexe.js" if "Hexe" in text else "eule.js", "where": "none"}
        else:
            ans = {"kind": "unknown"}
        out = {qid: {"type": "choice", "choice": ans.get(qid, "none"), "confidence": 0.9}
               for qid in body.get("questions", {})}
        payload = json.dumps({"answers": out, "usage": {"cost": 0.00004}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except OSError:
            pass

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Action(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright is not installed")
        cls.up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.world = Path(cls.tmp.name) / "world"
        shutil.copytree(ROOT / "viewer", cls.world / "viewer", ignore=shutil.ignore_patterns("__pycache__", "things"))
        (cls.world / "viewer" / "things").mkdir()
        (cls.world / "viewer" / "things" / "hexe.js").write_text(HEXE)
        (cls.world / "viewer" / "things" / "mond.js").write_text(MOND)
        (cls.world / "viewer" / "things" / "eule.js").write_text(EULE)
        cls.port = free_port()
        env = {**os.environ, "PORT": str(cls.port), "KRITZEL_THINK": "1", "OPENROUTER_API_KEY": "test-key",
               "KRITZEL_THINK_URL": f"http://127.0.0.1:{cls.up.server_port}/api/alpha/decisions"}
        cls.server = subprocess.Popen([sys.executable, str(cls.world / "viewer" / "serve.py")], cwd=cls.world, env=env,
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
        cls.browser = cls.pw.chromium.launch(headless=True, args=["--no-sandbox", "--use-angle=swiftshader",
                                                                  "--enable-unsafe-swiftshader"])
        cls.page = cls.browser.new_page(viewport={"width": 800, "height": 600})
        cls.errors = []
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/?seed=7")
        cls.page.wait_for_function("() => window.__paperWorld?.()?.actions?.()", timeout=30000)
        time.sleep(3)
        cls.page.evaluate("() => { window.requestAnimationFrame = () => 0; }")
        time.sleep(1.5)

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

    def send(self, text):
        return self.page.evaluate("""async (text) => {
          const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kritzel': '1' },
            body: JSON.stringify({ text }) });
          const j = await r.json();
          if (j.ok) window.__applyAction(j.command);
          return j;
        }""", text)

    def test_a_refused_action_is_not_confirmed_in_green(self):
        self.page.click('#textMode button[data-mode="action"]')
        self.page.fill("#textThingIn", "Der Mond soll tanzen")
        self.page.click("#textThing button.go")
        note = None
        for _ in range(40):
            time.sleep(0.2)
            note = self.page.evaluate("""() => ({ text: document.querySelector('#status .note').textContent,
              tone: document.querySelector('#status .note').dataset.tone,
              hidden: document.querySelector('#status .note').hidden })""")
            if not note["hidden"]:
                break
        self.assertEqual(note["tone"], "bad", note)
        self.assertRegex(note["text"], r"ging gerade nicht|did not work", note)
        self.assertIsNone(self.page.evaluate("""() => {
          const a = window.__paperWorld().brain().actors().find(x => x.id === 'hexe'); return a.action?.what ?? null;
        }"""))

    def test_snow_night_flight_and_unknown(self):
        snow = self.send("Es soll schneien")
        self.assertEqual(snow["command"], {"kind": "weather", "value": "snow"})
        self.page.evaluate("""() => { let t = 3000; for (let i = 0; i < 150; i++) window.__lighting().update(t += 1 / 30, 1 / 30); }""")
        weather = self.page.evaluate("() => window.__lighting().weather()")
        self.assertTrue(weather["snow"], weather)
        self.page.evaluate("() => window.__render()")
        try:
            self.page.screenshot(path=str(SHOT_SNOW), timeout=120000)
        except Exception:
            print("(snow screenshot skipped: software renderer too slow)")

        night = self.send("Es soll Nacht werden")
        self.assertEqual(night["command"], {"kind": "time", "value": "night"})
        self.page.evaluate("""() => { let t = 3100; for (let i = 0; i < 150; i++) window.__lighting().update(t += 1 / 30, 1 / 30); }""")
        self.assertEqual(self.page.evaluate("() => window.__lighting().name"), "night")

        flight = self.send("Die Hexe soll zum Mond fliegen")
        self.assertEqual(flight["command"], {"kind": "goal", "target": "hexe.js", "action": "fly_to", "where": "mond.js"})
        out = self.page.evaluate("""() => {
          const w = window.__paperWorld(), b = w.brain(), a = b.actors().find(x => x.id === 'hexe');
          const moon = b.things().find(x => x.file === 'mond.js');
          const before = { move: a.move, action: a.action, target: a.actionTarget, now: b.time() };
          let t = b.time();
          for (let i = 0; i < 60 * 12; i++) w.update(t += 1 / 60, 1 / 60);
          return { x: a.pos.x, z: a.pos.z, alt: a.alt, target: !!a.actionTarget, action: !!a.action,
                   moon: [moon.x, moon.y, moon.z], dist: Math.hypot(a.pos.x - moon.x, a.pos.z - moon.z), before };
        }""")
        self.assertTrue(out["target"], out)          # still holding at the moon under the active action
        self.assertLess(out["dist"], 0.2, out)
        self.assertGreater(out["alt"], 6, out)
        self.assertTrue(out["action"], out)
        self.page.evaluate("() => window.__render()")
        try:
            self.page.screenshot(path=str(SHOT_FLIGHT), timeout=120000)
        except Exception:
            print("(flight screenshot skipped: software renderer too slow)")

        # a second instruction for the same flyer replaces the flight completely (QA finding on 5792bbf)
        hexDance = self.send("Die Hexe soll tanzen")
        self.assertEqual(hexDance["command"], {"kind": "goal", "target": "hexe.js", "action": "dance", "where": None})
        hexState = self.page.evaluate("""() => {
          const a = window.__paperWorld().brain().actors().find(x => x.id === 'hexe');
          return { move: a.move, landedFrom: a.landedFrom, what: a.action?.what, target: !!a.actionTarget,
                   goal: a.goal?.type, meet: a.meet?.what, pos: [a.pos.x, a.pos.z], alt: a.alt };
        }""")
        self.assertFalse(hexState["target"], hexState)
        self.assertEqual(hexState["move"], "walk", hexState)
        self.assertEqual(hexState["landedFrom"], "fly", hexState)
        self.assertEqual(hexState["what"], "dance", hexState)
        self.assertEqual(hexState["meet"], "dance", hexState)
        self.assertLess(hexState["alt"], 0.01, hexState)
        self.assertGreater(abs(hexState["pos"][0]) + abs(hexState["pos"][1]), 0.5, hexState)

        held = self.page.evaluate("""() => {
          const a = window.__paperWorld().brain().actors().find(x => x.id === 'hexe');
          a.hold = { x: a.pos.x, z: a.pos.z, r: 2 };        // a jail holds her: no new instruction may move her
          const ok = window.__applyAction({ kind: 'goal', target: 'hexe.js', action: 'sleep', where: null });
          const what = a.action?.what;
          a.hold = null;
          return { ok, what };
        }""")
        self.assertFalse(held["ok"], held)
        self.assertNotEqual(held["what"], "sleep", held)

        dance = self.send("Die Eule soll tanzen")
        self.assertEqual(dance["command"], {"kind": "goal", "target": "eule.js", "action": "dance", "where": None})
        meet = self.page.evaluate("""() => {
          const a = window.__paperWorld().brain().actors().find(x => x.id === 'eule');
          return { action: a.action?.what, meet: a.meet, goal: a.goal };
        }""")
        self.assertEqual(meet["action"], "dance", meet)
        self.assertEqual(meet["meet"]["what"], "dance", meet)

        unknown = self.send("Mach die Welt bunt")
        self.assertEqual(unknown["command"]["kind"], "unknown")
        pill = self.page.evaluate("""() => { window.__status.tick(window.__camera); return document.querySelector('#status .text').textContent; }""")
        self.assertIn("nicht verstanden", pill)
        self.page.evaluate("() => window.__render()")
        try:
            self.page.screenshot(path=str(SHOT_UNKNOWN), timeout=120000)
        except Exception:
            print("(unknown screenshot skipped: software renderer too slow)")
        self.assertEqual(self.errors, [])
        print(f"\n[action] snow={weather} flight={out} unknown={unknown['command']} latency_ms={snow.get('ms')} cost={snow.get('usage')}")
        print(f"[action] screenshots: {SHOT_SNOW} {SHOT_FLIGHT} {SHOT_UNKNOWN}")


if __name__ == "__main__":
    unittest.main()
