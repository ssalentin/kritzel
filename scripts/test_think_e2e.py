"""End-to-end check: the viewer asks the director, applies its answer, and survives a dead endpoint.

    python3 -m unittest scripts/test_think_e2e.py

Starts the real serve.py on a free port and a fake Jev upstream that always answers "rest", opens the
viewer in headless Chromium (software WebGL), waits for a few rounds, then stops the upstream and
checks that the figures keep living on their local goals. Slow (~45 s) and needs Playwright:

    pip install playwright && python3 -m playwright install chromium
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
SHOT = Path("/tmp/kritzel-think-e2e.png")

# three friends for a clean checkout: viewer/things/ is empty there, so the test brings its own world.
# A thing's actors come from makePerson, the same rig every drawn figure uses.
FIXTURE = """export const meta = {{ name: 'Qa {n}', drawing: 'a small test figure', paper: {{ x: {x}, y: 0.5 }} }};
export function build({{ makePerson }}) {{
  const rig = makePerson({{ shirtColor: 0x{color} }});
  return {{ actors: [{{ id: 'qa-{n}', name: 'Qa {n}', start: [{x}, 0], rig }}] }};
}}
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Upstream(BaseHTTPRequestHandler):
    calls = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n))
        Upstream.calls.append(body)
        # dance first (so a meeting can prove the word travels), then a different word each round
        goal = ["dance", "dance", "dance", "dance", "rest", "inspect", "chat", "hide", "explore"][len(Upstream.calls) % 9]
        answers = {qid: {"type": "choice", "choice": goal, "probabilities": {goal: 1}, "confidence": 0.9}
                   for qid in body.get("questions", {})}
        out = json.dumps({"answers": answers, "usage": {"cost": 0.0000217}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


class Director(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright is not installed")
        cls.up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        # a private copy of the engine and a 3-actor world: the test does not depend on untracked things/
        cls.tmp = tempfile.TemporaryDirectory()
        cls.world = Path(cls.tmp.name) / "world"
        shutil.copytree(ROOT / "viewer", cls.world / "viewer", ignore=shutil.ignore_patterns("__pycache__", "things"))
        things = cls.world / "viewer" / "things"
        things.mkdir()
        for n, (x, color) in enumerate([(-2, "88cc88"), (0, "88aadd"), (2, "ddaa66")], 1):
            (things / f"qa-{n}.js").write_text(FIXTURE.format(n=n, x=x, color=color))
        cls.port = free_port()
        env = {**os.environ, "PORT": str(cls.port), "KRITZEL_THINK": "1", "OPENROUTER_API_KEY": "test-key",
               "KRITZEL_THINK_URL": f"http://127.0.0.1:{cls.up.server_port}/api/alpha/decisions"}
        cls.server = subprocess.Popen([sys.executable, str(cls.world / "viewer" / "serve.py")], cwd=cls.world, env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/api/think", timeout=0.5).read()
                break
            except OSError:
                if cls.server.poll() is not None:
                    raise RuntimeError("serve.py did not start: " + cls.server.stderr.read()[-500:])
                time.sleep(0.1)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, args=["--no-sandbox", "--use-angle=swiftshader",
                                                                  "--enable-unsafe-swiftshader"])
        cls.page = cls.browser.new_page(viewport={"width": 1000, "height": 700})
        cls.lines = []
        cls.errors = []
        cls.page.on("console", lambda m: cls.lines.append(m.text) if "[think]" in m.text else None)
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/?seed=7&cam=16,8.5,20,0,0.6,0")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.terminate()
        try:
            cls.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
        cls.up.shutdown()
        cls.tmp.cleanup()

    def sim(self, js):
        return self.page.evaluate(f"() => window.__paperWorld()?.brain()?.{js}")

    def test_director_answers_and_fallback_survives_dead_endpoint(self):
        deadline = time.time() + 40
        while time.time() < deadline and ((self.sim("think()?.requests") or 0) < 3 or (self.sim("think()?.goalsApplied") or 0) < 1):
            time.sleep(1)
        st = self.sim("think()")
        trace = self.sim("trace()") or []
        self.assertTrue(st["on"], st)
        self.assertGreaterEqual(st["requests"], 2, st)
        self.assertGreaterEqual(st["goalsApplied"], 1, st)
        self.assertTrue(any(p["why"] == "jev" for p in trace), trace[-10:])
        self.assertGreaterEqual(len(Upstream.calls), 2)
        first = Upstream.calls[0]
        self.assertTrue(3 <= len(first["state"]["actors"]) <= 5, first)
        self.assertEqual(len(first["questions"]), len(first["state"]["actors"]))
        self.assertTrue(all(a["id"] and a["mood"] and a["needs"] for a in first["state"]["actors"]))

        # the word has to survive the walk: a Jev dance becomes a dance when the two figures meet
        met = None
        until = time.time() + 75
        while time.time() < until and not met:
            met = next((p for p in (self.sim("trace()") or []) if p["why"] == "jev" and p["goal"] == "meet" and p["to"] == "dance"), None)
            if not met:
                time.sleep(2)
        self.assertIsNotNone(met, "no Jev interaction reached a meeting")
        self.assertEqual(met["to"], "dance")
        try:
            self.page.screenshot(path=str(SHOT), timeout=5000)   # nice to have; a slow software render must not fail the test
        except Exception:
            print("(screenshot skipped: the software renderer did not paint in 5 s)")

        # the endpoint dies: no answers from now on, but the world keeps running on local goals
        self.up.shutdown()
        before = self.sim("trace().length")
        time.sleep(12)
        after = self.sim("trace().length")
        st2 = self.sim("think()")
        self.assertGreater(after, before, "the sim stopped making goals after the endpoint died")
        self.assertGreater(st2["failed"], st["failed"])
        self.assertGreaterEqual(st2["requests"], st["requests"] + 1)
        self.assertEqual(self.errors, [])
        print("\n[think] console:\n  " + "\n  ".join(self.lines[-6:]))
        print(f"[think] stats after failover: {json.dumps(st2)}")
        print(f"[think] screenshot: {SHOT}")


if __name__ == "__main__":
    unittest.main()
