"""Tests for capture.py's sheet alignment, on synthetic pictures (no camera, no ffmpeg).

    python3 -m unittest scripts/test_capture.py
"""
import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import capture as c  # noqa: E402

W, H = c.W, c.H


def table(seed=1):
    """A wooden table: darker than paper, with grain."""
    rnd = random.Random(seed)
    phase = [rnd.uniform(0, 6) for _ in range(H)]
    return [-60 + 12 * math.sin(x / 7 + phase[y]) for y in range(H) for x in range(W)]


def sheet(seed=2, x0=20, y0=10, x1=300, y1=170, img=None):
    """A sheet of paper (x0..x1, y0..y1) on the table, with a drawing of pen strokes on it."""
    img = img or table()
    rnd = random.Random(seed)
    for y in range(y0, y1):
        for x in range(x0, x1):
            img[y * W + x] = 40
    for _ in range(40):                         # strokes: short dark lines
        x, y = rnd.uniform(x0 + 10, x1 - 10), rnd.uniform(y0 + 10, y1 - 10)
        a = rnd.uniform(0, math.pi)
        for k in range(rnd.randint(8, 25)):
            X, Y = round(x + k * math.cos(a)), round(y + k * math.sin(a))
            if x0 <= X < x1 and y0 <= Y < y1:
                img[Y * W + X] = -40
    return img


def moved(img, a, dx, dy, under):
    """`img`'s sheet turned by a degrees and slid by (dx, dy), lying on `under` where it isn't:
    the new picture q shows img at the point p with q = R(p - centre) + centre + d."""
    ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
    cx, cy, out = (W - 1) / 2, (H - 1) / 2, list(under)
    for y in range(H):
        for x in range(W):
            # inverse: p = R^-1(q - centre - d) + centre
            qx, qy = x - cx - dx, y - cy - dy
            X, Y = round(ca * qx + sa * qy + cx), round(-sa * qx + ca * qy + cy)
            if 0 <= X < W and 0 <= Y < H and img[Y * W + X] in (40, -40):     # paper or ink: the sheet
                out[y * W + x] = img[Y * W + X]
    return out


class Fit(unittest.TestCase):
    def test_large_turn_and_slide_never_runs_off_the_picture(self):
        # live 2026-10-17 15:47: a big turn plus slide indexed past fit()'s padded picture
        base = sheet()
        for a, dx, dy in ((c.TURN, c.REACH, c.REACH), (-c.TURN, -c.REACH, c.REACH), (c.TURN, -c.REACH, -c.REACH)):
            with self.subTest(a=a, dx=dx, dy=dy):
                c.fit(moved(base, a, dx, dy, table()), base)     # must not raise

    def test_a_turned_sheet_is_found(self):
        base = sheet()
        a, dx, dy = c.fit(moved(base, 4, 12, -6, table()), base)
        self.assertAlmostEqual(a, 4, delta=1)
        self.assertLessEqual(abs(dx - 12) + abs(dy + 6), 4)


class Far(unittest.TestCase):
    def test_a_sheet_pulled_half_out_of_view_is_the_same_sheet(self):
        base = sheet()
        r = c.far(moved(base, 0, 180, 4, table(seed=3)), base)
        self.assertIsNotNone(r)
        a, dx, dy, _ = r
        self.assertLessEqual(abs(dx - 180) + abs(dy - 4), 6)

    def test_an_empty_table_after_a_sheet_and_back(self):
        # live replay 2026-10-17: lining up against an empty table (no lines at all) raised in numpy
        empty = table(seed=5)
        self.assertIsNone(c.far(sheet(), empty))
        self.assertIsNone(c.far(empty, sheet()))
        self.assertIsNone(c.line_up(sheet(), empty, c.envelope(empty)))

    def test_a_different_sheet_is_not_the_old_one_moved(self):
        self.assertIsNone(c.far(sheet(seed=7, x0=50, y0=24, x1=270, y1=176), sheet(seed=2)))


class Detector(unittest.TestCase):
    def setUp(self):
        c.Detector.THREADED = False            # this test feeds pictures faster than real time

    def run_still(self, det, img, seconds=25):
        t = 0.0
        while t < seconds:
            got = det.feed(img, t)
            if got:
                return got
            t += 1 / c.FPS
        return None

    def test_a_pulled_sheet_is_never_handed_on_as_a_new_sheet(self):
        base = sheet()
        det = c.Detector(base)
        got = self.run_still(det, moved(base, 0, 180, 4, table(seed=3)))
        # nothing new: no frame at all; anything handed on carries the measured move, so generate
        # moves its things along instead of building the sheet again
        if got:
            self.assertIsNotNone(det.measured)

    def test_a_new_sheet_is_still_a_new_sheet(self):
        det = c.Detector(sheet(seed=2))
        got = self.run_still(det, sheet(seed=7, x0=50, y0=24, x1=270, y1=176))   # lies a little elsewhere
        self.assertEqual(got and got[0], "big-change")
        self.assertIsNone(det.measured)


if __name__ == "__main__":
    unittest.main()
