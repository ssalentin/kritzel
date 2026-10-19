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
CW, CH = c.CW, c.CH


def table(seed=1):
    """A wooden table: darker than paper, with grain."""
    rnd = random.Random(seed)
    phase = [rnd.uniform(0, 6) for _ in range(H)]
    return [-60 + 12 * math.sin(x / 7 + phase[y]) for y in range(H) for x in range(W)]


def sheet(seed=2, x0=20, y0=10, x1=300, y1=170, img=None, paper=40, ink=-40):
    """A sheet of paper (x0..x1, y0..y1) on the table, with a drawing of pen strokes on it."""
    img = img or table()
    rnd = random.Random(seed)
    for y in range(y0, y1):
        for x in range(x0, x1):
            img[y * W + x] = paper
    for _ in range(40):                         # strokes: short dark lines
        x, y = rnd.uniform(x0 + 10, x1 - 10), rnd.uniform(y0 + 10, y1 - 10)
        a = rnd.uniform(0, math.pi)
        for k in range(rnd.randint(8, 25)):
            X, Y = round(x + k * math.cos(a)), round(y + k * math.sin(a))
            if x0 <= X < x1 and y0 <= Y < y1:
                img[Y * W + X] = ink
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


def rgb_table(seed=1):
    """A table in colour: wood grain and sensor-like per-pixel noise, so no block is paper-flat."""
    rnd = random.Random(seed)
    phase = [rnd.uniform(0, 6) for _ in range(CH)]
    out = []
    for y in range(CH):
        for x in range(CW):
            n = rnd.randint(-14, 14)
            grain = 18 * math.sin(x / 5 + phase[y])
            out += [max(0, min(255, round(115 + grain + n))),
                    max(0, min(255, round(85 + grain * 0.8 + n))),
                    max(0, min(255, round(55 + grain * 0.5 + n)))]
    return out


def rgb_sheet(colour=(240, 210, 120), x0=8, y0=4, x1=88, y1=50, img=None, ink=(30, 25, 20), seed=2):
    """A sheet of any colour on a coloured table, with a few pen strokes."""
    img = img or rgb_table()
    rnd = random.Random(seed)
    for y in range(y0, y1):
        for x in range(x0, x1):
            i = (y * CW + x) * 3
            for c in range(3):
                img[i + c] = max(0, min(255, colour[c] + rnd.randint(-2, 2)))
    for _ in range(40):
        x, y = rnd.uniform(x0 + 4, x1 - 4), rnd.uniform(y0 + 4, y1 - 4)
        a = rnd.uniform(0, math.pi)
        for k in range(rnd.randint(8, 25)):
            X, Y = round(x + k * math.cos(a)), round(y + k * math.sin(a))
            if x0 <= X < x1 and y0 <= Y < y1:
                i = (Y * CW + X) * 3
                img[i:i + 3] = list(ink)
    return img


def rgb_hand(img, x=80, y=27, r=7):
    """A skin-coloured palm and forearm reaching in from the right, across the sheet's edge."""
    for yy in range(CH):
        for xx in range(CW):
            if ((xx - x) / r) ** 2 + ((yy - y) / (r * 1.25)) ** 2 <= 1 or (xx >= x and abs(yy - y) <= r * 0.75):
                i = (yy * CW + xx) * 3
                img[i:i + 3] = [205, 150, 118]
    return img


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

    def test_a_coloured_sheet_settles_like_a_white_one(self):
        det = c.Detector(sheet(seed=2))
        t, got = 0.0, None
        while t < 4:
            got = det.feed(sheet(seed=7, paper=-10, ink=-60), t)
            if got:
                break
            t += 1 / c.FPS
        self.assertEqual(got and got[0], "big-change")

    def test_a_hand_that_stays_on_the_paper_holds_the_frame(self):
        base = sheet()
        hand = sheet(seed=4)
        for y in range(30, 90):                 # a still hand on the sheet
            for x in range(210, 280):
                hand[y * W + x] = -20
        det = c.Detector(base)
        det.feed(hand, 0)
        det.hold()
        self.assertIsNone(self.run_still(det, hand, seconds=10))
        self.assertIsNone(det.candidate())
        # the hand lifts: a new drawing can settle
        self.assertIsNotNone(self.run_still(det, sheet(seed=8, x0=40, y0=20, x1=280, y1=160), seconds=10))

    def test_a_smooth_hand_movement_starts_a_paper_check_without_ink(self):
        # live #7: a skin-coloured hand on the drawing has no sharp new ink, so new_marks alone
        # gives no diff; the colour check must still get a chance to see it
        base = sheet()
        smooth = [v + (i % W) * 40 / W for i, v in enumerate(base)]
        det = c.Detector(base)
        det.feed(smooth, 0)
        for t in (0.35, 0.5):
            det.feed(smooth, t)
        self.assertIsNotNone(det.candidate())


class Paper(unittest.TestCase):
    def test_yellow_and_blue_sheets_are_both_found(self):
        for colour in ((240, 210, 120), (80, 130, 210)):
            with self.subTest(colour=colour):
                self.assertEqual(c.look(rgb_sheet(colour=colour)), "paper")

    def test_a_busy_colouring_page_is_still_paper(self):
        img = rgb_sheet()
        rnd = random.Random(11)
        for _ in range(2500):                   # dense line art breaks flat fields
            x, y = rnd.randint(10, 86), rnd.randint(6, 48)
            i = (y * CW + x) * 3
            img[i:i + 3] = [rnd.randint(0, 255) for _ in range(3)]
        self.assertEqual(c.look(img), "paper")

    def test_restart_noise_is_outside_the_sheet(self):
        img = rgb_table()
        for y in range(10, 44):
            for x in range(10, 86):
                i = (y * CW + x) * 3
                img[i:i + 3] = [240, 240, 240]
        outside = [60 * W + x for x in (10, 11, 12)]
        inside = [60 * W + x for x in range(150, 171)]
        self.assertTrue(c.restart_noise(outside, img))
        self.assertFalse(c.restart_noise(inside, img))

    def test_an_empty_table_has_no_paper(self):
        self.assertEqual(c.look(rgb_table()), "no-paper")

    def test_a_hand_on_the_sheet_is_a_hand(self):
        clean = rgb_sheet()
        self.assertEqual(c.look(rgb_hand(clean.copy()), clean), "hand")

    def test_the_table_already_in_the_last_picture_is_not_a_hand(self):
        clean = rgb_sheet()
        self.assertEqual(c.look(clean, clean), "paper")

    def test_table_uncovered_by_a_slid_sheet_is_not_a_hand(self):
        before = rgb_sheet()
        after = rgb_sheet(x0=30, seed=5)        # the sheet slid right; fresh table shows on the left
        self.assertEqual(c.look(after, before), "paper")

    def test_a_hand_beside_the_sheet_is_not_on_it(self):
        img = rgb_sheet(x0=14)
        for y in range(20, 40):                 # a hand on the table, left of the sheet
            for x in range(0, 8):
                i = (y * CW + x) * 3
                img[i:i + 3] = [205, 150, 118]
        self.assertEqual(c.look(img), "paper")


if __name__ == "__main__":
    unittest.main()
