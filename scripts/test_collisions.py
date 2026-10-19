"""A wide figure walks around a drawn thing that declares no obstacles.

    python3 -m unittest scripts/test_collisions.py

Builds a private world with a long beam (obstacles: []) and one wide walker, drives the sim 60 s
deterministically, and checks the walker's whole body never enters the beam's measured footprint
while it crosses to the other side. Before the fix, hutwicht (radius 1.2) crossed the live branch
(ast.js) by 1.69; this test fails on that code by construction.
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

BEAM = """export const meta = { name: 'Balken', drawing: 'a long thin beam, no declared obstacles', paper: { x: 0.5, y: 0.5 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.06, 1, 6), mat(0x9a6a3a));
  bar.position.y = 0.5;
  g.add(bar);
  world.add(g);
  return { actors: [], obstacles: [] };            // deliberately none: only the measured footprint can block
}
"""

WALKER = """export const meta = { name: 'Breiter', drawing: 'a broad walking figure', paper: { x: 0.47, y: 0.9 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x5588cc, scale: 4 });
  return { actors: [{ id: 'wide', name: 'Breiter', start: [-1.8, 4.8], rig, move: 'walk' }] };
}
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Collisions(unittest.TestCase):
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
        (cls.world / "viewer" / "things" / "balken.js").write_text(BEAM)
        (cls.world / "viewer" / "things" / "breiter.js").write_text(WALKER)
        cls.port = free_port()
        env = {**os.environ, "PORT": str(cls.port), "KRITZEL_THINK": "0"}
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
        cls.page = cls.browser.new_page(viewport={"width": 640, "height": 480})
        cls.errors = []
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/?seed=7")
        cls.page.wait_for_function("() => window.__paperWorld?.()?.brain?.()", timeout=30000)

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

    def test_wide_walker_goes_around_a_beam_without_obstacles(self):
        # the engine's own loop would run at the software renderer's pace: stop it and step the sim
        self.page.evaluate("() => { window.requestAnimationFrame = () => 0; }")
        time.sleep(1.5)
        out = self.page.evaluate("""() => {
          const w = window.__paperWorld(), b = w.brain();
          const e = w.feet().find(x => x.file === 'balken.js');
          if (!e || !e.foot) return { error: 'beam has no measured footprint' };
          const foot = e.foot, a = b.actors().find(x => x.id === 'wide');
          if (!a) return { error: 'walker missing' };
          const cell = (x, z) => [Math.round(x / 0.45 + 35), Math.round(z / 0.45 + 35)];
          // the live failure's start: just clear of the top-left corner, then a goal across the beam
          a.start = [foot.x - 2.25, foot.z + 5.4];
          [a.cell.x, a.cell.y] = cell(a.start[0], a.start[1]);
          a.pos.set(a.start[0], 0, a.start[1]);
          const goal = cell(foot.x + 6, foot.z - 5);   // a long diagonal: the rendered body must not chase through the corner
          let t = 1000, maxPen = -Infinity, path = 0, crossed = false, last = [a.pos.x, a.pos.z], samples = 0;
          const startSide = Math.sign(a.pos.x - foot.x) || 1;
          for (let i = 0; i < 60 * 60; i++) {
            // keep this figure on the test errand; the sim may otherwise replace it after 15 s
            a.goal = { type: 'wander', cell: goal, why: 'test' };
            a.goalSince = t + 1e6;
            a.busyUntil = Math.min(a.busyUntil, t);
            a.flee = null;
            t += 1 / 60;
            w.update(t, 1 / 60);
            if (i % 15) continue;
            samples++;
            const ox = foot.hx + a.radius - Math.abs(a.pos.x - foot.x);
            const oz = foot.hz + a.radius - Math.abs(a.pos.z - foot.z);
            maxPen = Math.max(maxPen, Math.min(ox, oz));       // positive = the body is inside the footprint
            path += Math.hypot(a.pos.x - last[0], a.pos.z - last[1]);
            last = [a.pos.x, a.pos.z];
            if (Math.sign(a.pos.x - foot.x) !== startSide && Math.abs(a.pos.x - foot.x) > foot.hx * 0.8) crossed = true;
          }
          return { error: '', obstacles: e.obstacles, foot: { x: foot.x, z: foot.z, hx: foot.hx, hz: foot.hz },
            radius: a.radius, actor: [a.pos.x, a.pos.z], maxPen, path, crossed, samples, goal,
            err: document.getElementById('err').textContent };
        }""")
        self.assertEqual(out["error"], "", out)
        self.assertEqual(out["obstacles"], [], "the beam must declare no obstacles for this test to mean anything")
        self.assertLessEqual(out["maxPen"], 0.02, f"body entered the beam footprint: {out}")
        self.assertGreater(out["path"], 5, f"the walker did not walk: {out}")
        self.assertTrue(out["crossed"], f"the walker did not get to the other side: {out}")
        self.assertEqual(out["err"], "")
        self.assertEqual(self.errors, [])
        print("\n[collisions] " + json.dumps(out))

    def test_rendered_body_cannot_cross_the_beam(self):
        """The grid may only know cells; the body is continuous. Aim a walker straight through the beam."""
        out = self.page.evaluate("""() => {
          const w = window.__paperWorld(), b = w.brain(), foot = w.feet().find(e => e.file === 'balken.js').foot;
          const a = b.actors().find(x => x.id === 'wide');
          const cell = (x, z) => ({ x: Math.round(x / 0.45 + 35), y: Math.round(z / 0.45 + 35) });
          const far = cell(foot.x, foot.z), near = [foot.x - foot.hx - a.radius - 0.4, foot.z + 3];
          a.pos.set(near[0], 0, near[1]);
          a.hidden = false; a.hold = null; a.alt = 0; a.busyUntil = 0; a.flee = null;
          let t = 2000, maxPen = -Infinity, samples = 0;
          for (let i = 0; i < 60 * 60; i++) {
            a.goal = { type: 'idle', until: t + 1e6 };
            a.cell = far;                         // the target cell is across the beam, every frame
            t += 1 / 60;
            w.update(t, 1 / 60);
            if (i % 15) continue;
            samples++;
            maxPen = Math.max(maxPen, Math.min(foot.hx + a.radius - Math.abs(a.pos.x - foot.x),
                                               foot.hz + a.radius - Math.abs(a.pos.z - foot.z)));
          }
          return { maxPen, samples, pos: [a.pos.x, a.pos.z], cell: { ...a.cell } };
        }""")
        self.assertLessEqual(out["maxPen"], 0.02, f"the rendered body crossed the beam: {out}")
        print("\n[collisions] continuous " + json.dumps(out))


if __name__ == "__main__":
    unittest.main()
