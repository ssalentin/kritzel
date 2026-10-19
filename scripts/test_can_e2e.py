"""End to end: a mouse takes a cookie, refuses a chest; a child takes the chest.

    python3 -m unittest scripts/test_can_e2e.py

Real server + headless viewer + fixture cast, with /api/can answered by a fake Jev. The figure's
pick goal is put next to the thing so the test is about the judgment and the carry path, not pathing.
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

MAUS = """export const meta = { name: 'Maus', drawing: 'a tiny mouse', paper: { x: 0.3, y: 0.5 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x8a6a4a, hairColor: 0x4a3020 });
  rig.g.scale.setScalar(0.12);
  return { actors: [{ id: 'maus', name: 'Maus', start: [1, 1], rig }] };
}
"""

KIND = """export const meta = { name: 'Kind', drawing: 'a child', paper: { x: 0.7, y: 0.5 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x6a8fd0, hairColor: 0x4a3020 });
  return { actors: [{ id: 'kind', name: 'Kind', start: [2, 2], rig }] };
}
"""

KEKS = """export const meta = { name: 'Keks', drawing: 'a biscuit', paper: { x: 0.4, y: 0.7 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.28, 12), mat(0xc08a4a));
  m.position.y = 0.14; g.add(m); world.add(g);
  return { obstacles: [{ x: 0, z: 0, r: 0.22 }] };
}
"""

TRUHE = """export const meta = { name: 'große Truhe', drawing: 'a big chest', paper: { x: 0.6, y: 0.6 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 0.9), mat(0x7a5a3a));
  m.position.y = 0.5; g.add(m); world.add(g);
  return { obstacles: [{ x: 0, z: 0, r: 0.7 }] };
}
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Carry(unittest.TestCase):
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
        for name, code in (("maus.js", MAUS), ("kind.js", KIND), ("keks.js", KEKS), ("truhe.js", TRUHE)):
            (cls.world / "viewer" / "things" / name).write_text(code)
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
        cls.browser = cls.pw.chromium.launch(headless=True, args=["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        cls.page = cls.browser.new_page(viewport={"width": 1000, "height": 700})
        cls.errors = []
        cls.calls = []
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))

        def can(route):
            body = json.loads(route.request.post_data or "{}")
            actor = (body.get("actor") or {}).get("name", "")
            thing = (body.get("thing") or {}).get("name", "")
            cls.calls.append([actor, thing])
            answer = thing == "Keks" or actor == "Kind"
            route.fulfill(json={"ok": True, "can": answer, "why": "fake"})

        cls.page.route("**/api/can", can)
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/?seed=7", wait_until="load")
        cls.page.wait_for_function("() => window.__paperWorld?.()?.brain", timeout=30000)
        time.sleep(4)

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

    def pick(self, actor, thing):
        return self.page.evaluate("""({actor, thing}) => {
          const b = window.__paperWorld().brain(), a = b.actors().find(x => x.id === actor);
          const it = b.spots().find(s => s.kind === 'portable' && s.name === thing);
          if (!a || !it) return null;
          a.pos.x = it.x; a.pos.z = it.z; a.goal = { type: 'pick', spot: it }; a.goalSince = b.time ? b.time() : 0;
          return { actor: a.id, thing: it.name, pos: [a.pos.x, a.pos.z], carrier: !!it.carrier };
        }""", {"actor": actor, "thing": thing})

    def step(self, n=60):
        self.page.evaluate("""(n) => {
          const w = window.__paperWorld(), b = w.brain(), t0 = b.time ? b.time() : 0;
          for (let i = 0; i < n; i++) w.update(t0 + i * 0.05, 0.05);
        }""", n)

    def state(self, actor, thing):
        return self.page.evaluate("""({actor, thing}) => {
          const b = window.__paperWorld().brain(), a = b.actors().find(x => x.id === actor);
          const it = b.spots().find(s => s.kind === 'portable' && s.name === thing);
          return { carrier: it?.carrier?.id ?? null, goal: a?.goal?.type ?? null,
                   goalItem: a?.goal?.item?.name ?? a?.goal?.spot?.name ?? null,
                   pos: a ? [a.pos.x, a.pos.z] : null, thing: it ? [it.x, it.z] : null };
        }""", {"actor": actor, "thing": thing})

    def test_cookie_chest_and_person(self):
        print("\n[carry] world", self.page.evaluate("""() => {
          const b = window.__paperWorld().brain();
          return { actors: b.actors().map(a => ({ id: a.id, name: a.name, height: a.height })),
                   portable: b.spots().filter(s => s.kind === 'portable').map(s => ({ name: s.name, r: s.r, top: s.top })),
                   feet: window.__paperWorld().feet().map(f => f.file) };
        }"""))
        self.page.evaluate("() => window.__paperWorld().brain().removeActor('kind')")   # isolate the mouse
        self.assertIsNotNone(self.pick("maus", "Keks"))
        self.step()
        time.sleep(0.3)
        self.step(20)
        self.assertEqual(self.state("maus", "Keks")["carrier"], "maus")

        self.pick("maus", "große Truhe")
        self.step()
        time.sleep(0.3)
        self.step(30)
        chest = self.state("maus", "große Truhe")
        self.assertIsNone(chest["carrier"], chest)
        self.assertNotEqual(chest["goalItem"], "große Truhe", chest)   # the mouse may carry its cookie on

        # the mouse's pair is cached: a second attempt makes no new call
        before = len(self.calls)
        self.pick("maus", "große Truhe")
        self.step(30)
        self.assertEqual(len(self.calls), before)
        self.assertEqual([c for c in self.calls if c[0] == "Maus" and c[1] == "große Truhe"], [["Maus", "große Truhe"]])
        # a fresh page for the child: a person can take the same chest
        self.page.reload()
        self.page.wait_for_function("() => window.__paperWorld?.()?.brain", timeout=30000)
        time.sleep(3)
        self.page.evaluate("() => window.__paperWorld().brain().removeActor('maus')")
        self.pick("kind", "große Truhe")
        self.step()
        time.sleep(0.3)
        self.step(20)
        self.assertEqual(self.state("kind", "große Truhe")["carrier"], "kind")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
