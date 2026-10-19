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

WALKER2 = """export const meta = { name: 'Breiter Zwei', drawing: 'a second broad figure' };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x9955aa, scale: 4 });
  return { actors: [{ id: 'wide2', name: 'Breiter Zwei', start: [2.2, 0.4], rig, move: 'walk' }] };
}
"""

KEKS = """export const meta = { name: 'Keks', drawing: 'a small biscuit', paper: { x: 0.8, y: 0.2 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.5), mat(0xc9964a));
  m.position.y = 0.125;
  g.add(m);
  world.add(g);
  return { actors: [], obstacles: [], spots: [{ kind: 'food', x: 0.8, z: 0.2, lines: { de: ['Mmh!'], en: ['Yum!'] } }] };
}
"""

JAIL = """export const meta = { name: 'Gefängnis', drawing: 'a little jail with bars', paper: { x: 0.2, y: 0.2 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group(), wood = mat(0x8a6a4a), iron = mat(0x555555);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(2, 0.12, 2), wood); floor.position.y = 0.06; g.add(floor);
  for (const x of [-0.9, 0, 0.9]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, 0.08), iron);
    bar.position.set(x, 0.8, 0.9); g.add(bar);
  }
  g.position.set(-6, 0, 4);
  world.add(g);
  return { actors: [], obstacles: [], holds: [{ actor: 'gaffer', x: -6, z: 4, r: 0.45 }] };
}
"""

GAFFER = """export const meta = { name: 'Gaffer', drawing: 'a broad figure in a jail' };
export function build({ makePerson }) {
  const rig = makePerson({ shirtColor: 0x777777, scale: 3 });
  return { actors: [{ id: 'gaffer', name: 'Gaffer', start: [-6, 4], rig, move: 'walk' }] };
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
        (cls.world / "viewer" / "things" / "breiter2.js").write_text(WALKER2)
        (cls.world / "viewer" / "things" / "keks.js").write_text(KEKS)
        (cls.world / "viewer" / "things" / "gefaengnis.js").write_text(JAIL)
        (cls.world / "viewer" / "things" / "gaffer.js").write_text(GAFFER)
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
          const other = b.actors().find(x => x.id === 'wide2');       // park the crowding partner out of this walk
          if (other) { other.pos.set(-7, 0, 5); [other.cell.x, other.cell.y] = cell(-7, 5);
            other.goal = { type: 'idle', until: 1e9 }; other.busyUntil = 0; other.partner = null; }
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

    def test_crowding_does_not_push_into_the_beam(self):
        """Two wide figures overlap: the pair push must not shove one into the beam (one is partnered/idle)."""
        out = self.page.evaluate("""() => {
          const w = window.__paperWorld(), b = w.brain(), foot = w.feet().find(e => e.file === 'balken.js').foot;
          const a = b.actors().find(x => x.id === 'wide'), c = b.actors().find(x => x.id === 'wide2');
          const cell = (x, z) => ({ x: Math.round(x / 0.45 + 35), y: Math.round(z / 0.45 + 35) });
          a.pos.set(foot.x + foot.hx + a.radius + 0.15, 0, foot.z); Object.assign(a.cell, cell(a.pos.x, a.pos.z));
          c.pos.set(foot.x + foot.hx + a.radius + 0.15 + c.radius, 0, foot.z); Object.assign(c.cell, cell(c.pos.x, c.pos.z));
          for (const p of [a, c]) { p.hidden = false; p.hold = null; p.alt = 0; p.busyUntil = 0; p.goal = null; p.flee = null; }
          let t = b.time(), maxPen = -Infinity;
          for (let i = 0; i < 60 * 5; i++) {
            a.partner = c; a.partnerUntil = t + 1e6; a.goal = null;
            c.goal = { type: 'idle', until: t + 1e6 };
            w.update(t += 1 / 60, 1 / 60);
            if (i % 15) continue;
            for (const p of [a, c]) maxPen = Math.max(maxPen,
              Math.min(foot.hx + p.radius - Math.abs(p.pos.x - foot.x), foot.hz + p.radius - Math.abs(p.pos.z - foot.z)));
          }
          return { maxPen, a: [a.pos.x, a.pos.z], c: [c.pos.x, c.pos.z], r: [a.radius, c.radius] };
        }""")
        self.assertLessEqual(out["maxPen"], 0.02, f"a crowd pushed a body into the beam: {out}")
        print("\n[collisions] crowding " + json.dumps(out))

    def test_a_body_already_inside_is_never_pushed_deeper(self):
        """A saved state may leave a figure inside a thing; its next step must not make it worse."""
        out = self.page.evaluate("""() => {
          const w = window.__paperWorld(), b = w.brain(), foot = w.feet().find(e => e.file === 'balken.js').foot;
          const a = b.actors().find(x => x.id === 'wide'), c = b.actors().find(x => x.id === 'wide2');
          if (c) { c.pos.set(-7, 0, 5); c.cell = { x: 19, y: 46 }; c.goal = { type: 'idle', until: 1e9 }; }
          const pen = x => foot.hx + a.radius - Math.abs(x - foot.x);      // the x axis into the beam
          a.hidden = false; a.hold = null; a.alt = 0; a.busyUntil = 0; a.partner = null; a.flee = null;
          a.pos.set(foot.x - 0.2, 0, foot.z + 2.5); a.cell = { x: Math.round(foot.x / 0.45 + 35), y: Math.round(foot.z / 0.45 + 35) };
          const before = pen(a.pos.x), t = b.time();
          a.goal = { type: 'idle', until: t + 1e9 };
          a.goalSince = t + 1e9;
          w.update(t + 1 / 60, 1 / 60);
          return { before, after: pen(a.pos.x), pos: [a.pos.x, a.pos.z] };
        }""")
        self.assertLessEqual(out["after"], out["before"] + 1e-4, f"the body was pushed deeper: {out}")
        print("\n[collisions] already-inside " + json.dumps(out))

    def test_portable_food_and_a_held_prisoner_are_not_walls(self):
        out = self.page.evaluate("""() => {
          const w = window.__paperWorld(), b = w.brain();
          const entry = file => w.feet().find(e => e.file === file);
          const inGrid = (e, list) => !!e?.foot && list.some(p => Math.abs(p.x - e.foot.x) < 0.02 &&
            Math.abs(p.z - e.foot.z) < 0.02 && Math.abs(p.hx - e.foot.hx) < 0.02 && Math.abs(p.hz - e.foot.hz) < 0.02);
          const blocking = b.blockingFeet(), keks = entry('keks.js'), jail = entry('gefaengnis.js');
          const gaffer = b.actors().find(a => a.id === 'gaffer');
          return { keksFoot: !!keks?.foot, keksBlocking: inGrid(keks, blocking), jailFoot: !!jail?.foot,
            jailBlocking: inGrid(jail, blocking), jailPinned: !!jail?.pinned, held: !!gaffer?.hold };
        }""")
        self.assertTrue(out["keksFoot"], out)
        self.assertFalse(out["keksBlocking"], f"a portable Keks became a wall: {out}")
        self.assertTrue(out["jailFoot"], out)
        self.assertTrue(out["jailPinned"], out)
        self.assertFalse(out["jailBlocking"], f"a jail holding its prisoner became a wall: {out}")
        self.assertTrue(out["held"], f"the prisoner is not held: {out}")
        print("\n[collisions] exemptions " + json.dumps(out))

    def test_adding_and_removing_a_thing_rebuilds_the_solid_grid(self):
        new = self.world / "viewer" / "things" / "neu.js"
        new.write_text("""export const meta = { name: 'Neu', drawing: 'a box', paper: { x: 0.6, y: 0.6 } };
export function build({ THREE, world, mat }) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 3), mat(0xaa8844));
  m.position.y = 0.5; g.add(m); world.add(g);
  return { actors: [], obstacles: [] };
}
""")
        try:
            try:
                added = self.page.wait_for_function("""() => {
                  const w = window.__paperWorld();
                  const e = w?.feet?.().find(x => x.file === 'neu.js');
                  if (!e?.foot) return false;
                  return w.brain().blockingFeet().some(p => Math.abs(p.x - e.foot.x) < 0.02 && Math.abs(p.z - e.foot.z) < 0.02);
                }""", timeout=30000)
            except Exception:
                print("\n[collisions] add diag " + json.dumps(self.page.evaluate("""() => ({
                  feet: window.__paperWorld()?.feet?.().map(x => x.file),
                  err: document.getElementById('err').textContent,
                  has: typeof window.__paperWorld()?.brain?.().blockingFeet })""")))
                raise
            self.assertTrue(added)
            foot = self.page.evaluate("() => { const e = window.__paperWorld().feet().find(x => x.file === 'neu.js'); return { x: e.foot.x, z: e.foot.z, hx: e.foot.hx, hz: e.foot.hz }; }")
        finally:
            new.unlink()
        self.page.wait_for_function("""() => !window.__paperWorld()?.feet?.().some(x => x.file === 'neu.js')""", timeout=15000)
        gone = self.page.evaluate("""(f) => ({ feet: window.__paperWorld().feet().some(x => x.file === 'neu.js'),
          blocking: window.__paperWorld().brain().blockingFeet().some(p => Math.abs(p.x - f.x) < 0.02 && Math.abs(p.z - f.z) < 0.02) })""", foot)
        self.assertFalse(gone["feet"], gone)
        self.assertFalse(gone["blocking"], gone)
        print("\n[collisions] grid rebuild on add/remove ok")

    def test_a_crowd_does_not_push_the_prisoner_out_of_the_jail(self):
        out = self.page.evaluate("""() => {
          const w = window.__paperWorld(), b = w.brain();
          const g = b.actors().find(a => a.id === 'gaffer'), h = g.hold;
          if (!h) return { error: 'the prisoner has no hold' };
          const a = b.actors().find(x => x.id === 'wide'), c = b.actors().find(x => x.id === 'wide2');
          const cell = (x, z) => ({ x: Math.round(x / 0.45 + 35), y: Math.round(z / 0.45 + 35) });
          const gc = cell(h.x, h.z), gw = [(gc.x - 35) * 0.45, (gc.y - 35) * 0.45];
          g.cell = gc; g.pos.set(gw[0], 0, gw[1]); g.hidden = false; g.busyUntil = 0; g.goal = null;
          const start = [gw[0], gw[1]];
          for (const p of [a, c]) { p.hidden = false; p.hold = null; p.alt = 0; p.busyUntil = 0; p.goal = null; p.flee = null; }
          a.pos.set(gw[0] + 0.4, 0, gw[1]); Object.assign(a.cell, cell(a.pos.x, a.pos.z));
          c.pos.set(gw[0] + 1.4, 0, gw[1]); Object.assign(c.cell, cell(c.pos.x, c.pos.z));
          let t = b.time(), maxOut = 0;
          for (let i = 0; i < 60 * 5; i++) {
            a.partner = c; a.partnerUntil = t + 1e6; a.goal = null;
            c.goal = { type: 'idle', until: t + 1e6 };
            g.goal = { type: 'idle', until: t + 1e6 };
            w.update(t += 1 / 60, 1 / 60);
            maxOut = Math.max(maxOut, Math.hypot(g.pos.x - start[0], g.pos.z - start[1]));
          }
          return { maxOut, r: h.r, g: [g.pos.x, g.pos.z], h: [h.x, h.z] };
        }""")
        self.assertNotIn("error", out, out)
        self.assertLessEqual(out["maxOut"], 0.02, f"the crowd moved the prisoner: {out}")
        print("\n[collisions] prisoner " + json.dumps(out))


if __name__ == "__main__":
    unittest.main()
