"""Per-thing sound recipes: name mapping, family coverage, determinism and file limits.

    python3 -m unittest scripts/test_thing_sounds.py

The mapping tests need only Python. The render tests use the pinned .kritzel/earshot checkout
and venv (scripts/thing_sounds.py --ensure) and skip when they are absent.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "thing_sounds.py"


def load():
    spec = importlib.util.spec_from_file_location("thing_sounds", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Mapping(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def family(self, name, kind="", move=""):
        return self.m.family_for(name, kind, move)

    def test_the_required_families_are_reachable(self):
        cases = [
            ("Drache", "actor", "fly", "magic"), ("Vogel", "actor", "fly", "fly"),
            ("Fisch", "actor", "swim", "swim"), ("Schnecke", "actor", "crawl", "walk"),
            ("Baum", "", "", "plant"), ("Tisch", "", "", "thing"),
            ("Haus", "", "", "building"), ("Auto", "", "", "vehicle"),
            ("Laterne", "", "", "light"), ("Hexe", "actor", "fly", "magic"),
        ]
        for name, kind, move, family in cases:
            self.assertEqual(self.family(name, kind, move), family, name)

    def test_magic_presets(self):
        self.assertEqual(self.m.preset_for("Drache", "magic"), "growl")
        self.assertEqual(self.m.preset_for("Hexe", "magic"), "sparkle")

    def test_compounds_and_movement_fallbacks(self):
        self.assertEqual(self.family("Baumhaus"), "building")
        self.assertEqual(self.family("Taschenlampe"), "light")
        self.assertEqual(self.family("Wolke"), "weather")
        self.assertEqual(self.family("Fels mit Wasserfall"), "weather")
        self.assertEqual(self.family("Unbekannt", "actor", "walk"), "walk")
        self.assertEqual(self.family("Unbekannt", "", ""), "thing")
        self.assertEqual(self.family("Unbekannt", "actor", "fly"), "fly")
        self.assertEqual(self.family("Unbekannt", "actor", "swim"), "swim")

    def test_seed_is_stable(self):
        self.assertEqual(self.m.seed_of("drache"), self.m.seed_of("drache"))
        self.assertNotEqual(self.m.seed_of("drache"), self.m.seed_of("hexe"))


class Render(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load()
        if not (Path(cls.m.EARSHOT_DIR) / ".git").is_dir() or not os.path.exists(cls.m.venv_python()):
            raise unittest.SkipTest("earshot is not set up: run scripts/thing_sounds.py --ensure")

    def render(self, family, out, seed=None):
        r = subprocess.run([sys.executable, str(SCRIPT), "--family", family, "--name", family,
                            "--seed", seed or family, "--out", str(out)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_family_renders_a_small_deterministic_ogg(self):
        with tempfile.TemporaryDirectory(prefix="kritzel-thing-sounds-") as tmp:
            for family in self.m.FAMILIES:
                a = Path(tmp) / f"{family}.ogg"
                info = self.render(family, a)
                self.assertEqual(a.read_bytes()[:4], b"OggS", family)
                self.assertLess(a.stat().st_size, 30 * 1024, family)
                self.assertEqual(info["family"], family)
                self.assertGreaterEqual(info["duration"], 0.3, family)
                self.assertLessEqual(info["duration"], 0.9, family)
                probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                        "-of", "json", str(a)], capture_output=True, text=True, check=True)
                seconds = float(json.loads(probe.stdout)["format"]["duration"])
                self.assertGreaterEqual(seconds, 0.29, family)
                self.assertLessEqual(seconds, 0.91, family)
                loud = subprocess.run(["ffmpeg", "-i", str(a), "-af", "volumedetect", "-f", "null", "-"],
                                      capture_output=True, text=True)
                peak = float(re.search(r"max_volume:\s*(-?[\d.]+) dB", loud.stderr).group(1))
                self.assertGreaterEqual(peak, -6.0, f"{family} is too quiet: {peak} dB")
                self.assertLessEqual(peak, -1.0, f"{family} clips: {peak} dB")
            # the same seed and family give the same bytes (checked on two families: the recipes share the path)
            for family in ("magic", "thing"):
                a, b = Path(tmp) / f"{family}-a.ogg", Path(tmp) / f"{family}-b.ogg"
                self.render(family, a)
                self.render(family, b)
                self.assertEqual(a.read_bytes(), b.read_bytes(), f"{family} is not deterministic")

    def test_a_name_and_move_choose_the_family_in_the_cli(self):
        with tempfile.TemporaryDirectory(prefix="kritzel-thing-sounds-") as tmp:
            out = Path(tmp) / "drache.ogg"
            r = subprocess.run([sys.executable, str(SCRIPT), "--name", "Drache", "--kind", "actor",
                                "--move", "fly", "--seed", "drache", "--out", str(out)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            info = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertEqual((info["family"], info["preset"]), ("magic", "growl"))
            self.assertTrue(out.exists())


if __name__ == "__main__":
    unittest.main()
