"""The hand cursor: push a thing, carry a figure and a small thing, leave tap/long-press alone.

    python3 -m unittest scripts/test_hand.py

Real serve.py + headless viewer with three drawn fixtures, no camera. The animation loop is frozen
after the first render so a pointer drag lands on exactly the thing it was aimed at; the sim is
stepped by hand where a carried figure needs a frame to follow the hand.
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
SHOT_CARRY = Path("/tmp/kritzel-hand-carry.png")
SHOT_DROP = Path("/tmp/kritzel-hand-drop.png")
SHOT_GLOVE = Path("/tmp/kritzel-hand-glove-open-1440.png")
SHOT_PINCH = Path("/tmp/kritzel-hand-glove-pinch-1440.png")
SHOT_OPEN_AFTER = Path("/tmp/kritzel-hand-glove-open-after-1440.png")
SHOT_GLOVE_PHONE = Path("/tmp/kritzel-hand-glove-open-390.png")
SHOT_PINCH_PHONE = Path("/tmp/kritzel-hand-glove-pinch-390.png")

FIGUR = """export const meta = { name: 'Mira', drawing: 'a person', paper: { x: 0.3, y: 0.6 } };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x6a8fd0, hairColor: 0x4a3020 });
  return { actors: [{ id: 'mira', name: 'Mira', start: [1, 1], rig }] };
}
"""

STEIN = """export const meta = { name: 'Stein', drawing: 'a grey rock', paper: { x: 0.5, y: 0.5 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 1.6), mat(0x9a9a9a));
  m.position.y = 0.6; g.add(m); world.add(g);
  return { obstacles: [{ x: 0, z: 0, r: 0.9 }] };
}
"""

APFEL = """export const meta = { name: 'Apfel', drawing: 'a small red apple', paper: { x: 0.6, y: 0.4 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), mat(0xcc3a3a));
  m.position.y = 0.25; g.add(m); world.add(g);
  return { obstacles: [{ x: 0, z: 0, r: 0.25 }] };
}
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Hand(unittest.TestCase):
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
        for name, code in (("figur.js", FIGUR), ("stein.js", STEIN), ("apfel.js", APFEL)):
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
        cls.page = cls.browser.new_page(viewport={"width": 800, "height": 600})
        cls.errors = []
        cls.page.on("pageerror", lambda e: cls.errors.append(str(e)))
        cls.page.goto(f"http://127.0.0.1:{cls.port}/viewer/?cam=12,10,16,0,0.6,0&seed=7")
        cls.page.wait_for_function("() => window.__paperWorld?.()?.canPush", timeout=30000)
        time.sleep(3)
        cls.page.evaluate("() => { window.requestAnimationFrame = () => 0; }")
        time.sleep(1)
        cls.t = 10.0

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

    def step(self, dt=0.05):
        self.__class__.t += dt
        self.page.evaluate("(t) => window.__paperWorld().update(t, 0.05)", self.t)

    def point_on(self, file=None, actor=None):
        """A screen point that actually hits the thing (or the figure's rig), by a small scan."""
        return self.page.evaluate("""async ({file, actor}) => {
          const THREE = await import('three');
          const w = window.__paperWorld();
          const target = file ? w.box(file) : w.brain().actors().find(a => a.id === actor)?.rig.g;
          if (!target) return null;
          const root = w.box('stein.js').parent;          // the whole world: respect what is in front
          const box = new THREE.Box3().setFromObject(target), c = box.getCenter(new THREE.Vector3()).project(window.__camera);
          const r = document.querySelector('canvas').getBoundingClientRect();
          const cx = r.left + (c.x * .5 + .5) * r.width, cy = r.top + (-c.y * .5 + .5) * r.height;
          const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
          for (let ring = 0; ring < 120; ring += 4) {
            for (const [dx, dy] of [[0, 0], [ring, 0], [-ring, 0], [0, ring], [0, -ring], [ring, ring], [-ring, ring], [ring, -ring], [-ring, -ring]]) {
              const x = cx + dx, y = cy + dy;
              if (document.elementFromPoint(x, y) !== document.querySelector('canvas')) continue;   // a panel is in front
              ptr.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1);
              ray.setFromCamera(ptr, window.__camera);
              const hit = ray.intersectObjects(root.children, true)[0]?.object;
              if (!hit) continue;
              if (file ? w.fileOf(hit) === file : (() => { let o = hit; while (o && o !== target) o = o.parent; return !!o; })()) return { x, y };
            }
          }
          return null;
        }""", {"file": file, "actor": actor})

    def drag(self, start, dx, dy, steps=9):
        self.page.mouse.move(start["x"], start["y"])
        self.page.mouse.down()
        for i in range(1, steps + 1):
            self.page.mouse.move(start["x"] + dx * i / steps, start["y"] + dy * i / steps)
            self.page.wait_for_timeout(40)
        return self.page.evaluate("() => __handState()")

    def test_page_raycast(self):
        inside = self.page.evaluate("() => window.__pageAt({ clientX: 400, clientY: 300 })")
        self.assertIsNotNone(inside)
        self.assertLess(abs(inside["x"]), 9)
        self.assertLess(abs(inside["z"]), 6.5)
        self.assertIsNone(self.page.evaluate("() => window.__pageAt({ clientX: -20, clientY: -20 })"))

    def test_push_moves_the_thing_and_its_obstacle(self):
        before = self.page.evaluate("""() => { const w = window.__paperWorld(), e = w.feet().find(x => x.file === 'stein.js');
          return { foot: [e.foot.x, e.foot.z], obs: e.obstacles.map(o => [o.x, o.z]) }; }""")
        p = self.point_on(file="stein.js")
        self.assertIsNotNone(p, "no visible point on the rock")
        mid = self.drag(p, 120, 20)
        self.assertEqual(mid["grab"]["file"], "stein.js", mid)
        self.page.mouse.up()
        time.sleep(0.4)
        after = self.page.evaluate("""() => { const w = window.__paperWorld(), e = w.feet().find(x => x.file === 'stein.js');
          return { foot: [e.foot.x, e.foot.z], obs: e.obstacles.map(o => [o.x, o.z]) }; }""")
        dx, dz = after["foot"][0] - before["foot"][0], after["foot"][1] - before["foot"][1]
        self.assertGreater(abs(dx) + abs(dz), 0.3, (before, after))
        for a, b in zip(before["obs"], after["obs"]):
            self.assertAlmostEqual(b[0] - a[0], dx, 2)
            self.assertAlmostEqual(b[1] - a[1], dz, 2)

    def test_carry_a_figure_and_put_it_down(self):
        p = self.point_on(actor="mira")
        self.assertIsNotNone(p, "no visible point on Mira")
        mid = self.drag(p, 90, -40)
        self.assertEqual(mid["carry"]["who"], "mira", mid)
        self.step()
        held = self.page.evaluate("""() => { const a = window.__paperWorld().brain().actors().find(x => x.id === 'mira');
          return { held: a.held, alt: a.alt, pos: [a.pos.x, a.pos.z] }; }""")
        self.assertTrue(held["held"], held)
        self.assertGreater(held["alt"], 0.5, held)
        self.assertIsNone(self.page.evaluate("""() => {
          const a = window.__paperWorld().brain().actors().find(x => x.id === 'mira'); return a.goal;
        }"""))
        # action mode must refuse a figure that the hand is holding
        refused = self.page.evaluate("""() => {
          const a = window.__paperWorld().brain().actors().find(x => x.id === 'mira');
          const ok = window.__applyAction?.({ kind: 'goal', target: 'figur.js', action: 'sleep', where: null });
          return { ok: !!ok, what: a.action?.what ?? null };
        }""")
        self.assertFalse(refused["ok"], refused)
        self.assertIsNone(refused["what"], refused)
        self.page.evaluate("() => window.__render()")
        try:
            self.page.screenshot(path=str(SHOT_CARRY), timeout=120000)
        except Exception:
            print("(carry screenshot skipped: software renderer too slow)")
        # carry her over the rock, then let go: the release must not leave her inside it
        rock = self.point_on(file="stein.js")
        self.page.mouse.move(rock["x"], rock["y"])
        self.page.wait_for_timeout(200)
        self.step()
        self.page.mouse.up()
        time.sleep(0.3)
        self.step()
        down = self.page.evaluate("""() => {
          const w = window.__paperWorld(), a = w.brain().actors().find(x => x.id === 'mira');
          const f = w.feet().find(x => x.file === 'stein.js').foot;
          return { held: a.held, alt: a.alt, cell: a.cell, pos: [a.pos.x, a.pos.z],
                   inside: Math.abs(a.pos.x - f.x) < f.hx + 0.05 && Math.abs(a.pos.z - f.z) < f.hz + 0.05 };
        }""")
        self.assertIsNone(down["held"], down)
        self.assertEqual(down["alt"], 0, down)
        self.assertIsNotNone(down["cell"], down)
        self.assertFalse(down["inside"], down)
        # and she walks again after the release
        for _ in range(120):
            self.step()
        moved = self.page.evaluate("""(p) => {
          const a = window.__paperWorld().brain().actors().find(x => x.id === 'mira');
          return Math.hypot(a.pos.x - p[0], a.pos.z - p[1]);
        }""", down["pos"])
        self.assertGreater(moved, 0.05, moved)
        self.page.evaluate("() => window.__render()")
        try:
            self.page.screenshot(path=str(SHOT_DROP), timeout=120000)
        except Exception:
            print("(drop screenshot skipped: software renderer too slow)")

    def test_carry_a_portable_thing(self):
        p = self.point_on(file="apfel.js")
        self.assertIsNotNone(p, "no visible point on the apple")
        mid = self.drag(p, 70, 30)
        self.assertEqual(mid["carry"]["file"], "apfel.js", mid)
        lifted = self.page.evaluate("""() => { const w = window.__paperWorld(); return { y: w.box('apfel.js').position.y }; }""")
        self.assertGreater(lifted["y"], 0.6, lifted)
        self.page.mouse.up()
        time.sleep(0.5)
        down = self.page.evaluate("""() => { const w = window.__paperWorld(), e = w.feet().find(x => x.file === 'apfel.js');
          return { y: w.box('apfel.js').position.y, state: __handState(), foot: [e.foot.x, e.foot.z] }; }""")
        self.assertIsNone(down["state"]["carry"], down)
        self.assertLess(abs(down["y"]), 0.3, down)
        self.assertIsNotNone(down["foot"], down)

    def test_tap_and_long_press_still_work(self):
        p = self.point_on(actor="mira")
        self.page.mouse.click(p["x"], p["y"])
        time.sleep(0.4)
        tap = self.page.evaluate("""() => { const a = window.__paperWorld().brain().actors().find(x => x.id === 'mira');
          return { anim: a.anim, jumpAt: a.jumpAt ?? 0 }; }""")
        self.assertEqual(tap["anim"], "wave", tap)
        self.assertGreater(tap["jumpAt"], 0, tap)
        self.page.mouse.move(p["x"], p["y"])
        self.page.mouse.down()
        time.sleep(0.65)
        self.page.mouse.up()
        time.sleep(0.6)
        focus = self.page.evaluate("() => window.__focus()?.id ?? null")
        self.assertEqual(focus, "mira")

    def test_no_page_errors(self):
        self.assertEqual(self.errors, [])

    def test_the_glove_reads_open_and_pinched_at_both_sizes(self):
        self.page.evaluate("""() => {                 // a central figure, away from the panels at both sizes
          const a = window.__paperWorld().brain().actors().find(x => x.id === 'mira');
          a.pos.set(0, 0, 0); a.rig.g.position.set(0, 0, 0); a.rig.g.visible = true; a.goal = null; a.held = null;
        }""")
        time.sleep(0.2)
        for w, h, open_shot, pinch_shot in ((1440, 900, SHOT_GLOVE, SHOT_PINCH), (390, 844, SHOT_GLOVE_PHONE, SHOT_PINCH_PHONE)):
            self.page.set_viewport_size({"width": w, "height": h})
            time.sleep(0.3)
            self.page.mouse.move(w * 0.5, h * 0.52)
            time.sleep(0.3)
            self.page.evaluate("() => { for (let i = 0; i < 4; i++) __handRig.update(0.08, i * 0.08, { moving: true }); window.__render(); }")
            state = self.page.evaluate("() => ({ ...__handState(), cursor: getComputedStyle(document.querySelector('canvas')).cursor })")
            self.assertTrue(state["visible"], state)
            self.assertEqual(state["cursor"], "none", state)
            try:
                self.page.screenshot(path=str(open_shot), timeout=120000)
            except Exception:
                print("(glove screenshot skipped: software renderer too slow)")

            p = self.point_on(actor="mira")
            if not p:
                self.skipTest("no visible point on Mira")
            self.page.mouse.move(p["x"], p["y"])
            self.page.mouse.down()
            for i in range(1, 7):
                self.page.mouse.move(p["x"] + 6 * i, p["y"] - 3 * i)
                self.page.wait_for_timeout(40)
            self.page.evaluate("() => { for (let i = 0; i < 8; i++) __handRig.update(0.08, 1 + i * 0.08, { carrying: true, pressing: true, moving: true }); window.__render(); }")
            pinch = self.page.evaluate("() => __handState()")
            self.assertEqual(pinch["carry"]["who"], "mira", pinch)
            self.assertGreater(pinch["pinch"], 0.8, pinch)
            self.assertEqual(pinch["pose"], "pinch", pinch)
            try:
                self.page.screenshot(path=str(pinch_shot), timeout=120000)
            except Exception:
                print("(pinch screenshot skipped: software renderer too slow)")
            self.page.mouse.up()
            time.sleep(0.3)
            self.page.evaluate("() => { for (let i = 0; i < 8; i++) __handRig.update(0.08, 2 + i * 0.08, { moving: true }); window.__render(); }")
            opened = self.page.evaluate("() => __handState()")
            self.assertLess(opened["pinch"], 0.2, opened)
            if w == 1440:
                try:
                    self.page.screenshot(path=str(SHOT_OPEN_AFTER), timeout=120000)
                except Exception:
                    print("(open-after screenshot skipped: software renderer too slow)")
        # over a panel the normal cursor is back and the hand is gone
        self.page.hover("#newBtn")
        time.sleep(0.3)
        panel = self.page.evaluate("""() => ({ hand: __hand.visible, cursor: getComputedStyle(document.getElementById('newBtn')).cursor })""")
        self.assertFalse(panel["hand"], panel)
        self.assertNotEqual(panel["cursor"], "none", panel)


if __name__ == "__main__":
    unittest.main()
