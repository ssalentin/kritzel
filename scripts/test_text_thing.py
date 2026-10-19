"""The text -> thing endpoint: validation, the request file it writes, and unique ids.

Run: python3 -m unittest scripts/test_text_thing.py
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
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


class TextThing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "viewer").mkdir()
        shutil.copy(HERE / "viewer" / "serve.py", self.root / "viewer" / "serve.py")
        (self.root / "VERSION").write_text("test\n")
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        self.port = s.getsockname()[1]
        s.close()
        self.p = subprocess.Popen([sys.executable, str(self.root / "viewer" / "serve.py")],
                                  env={**os.environ, "PORT": str(self.port)},
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/version", timeout=0.2)
                break
            except OSError:
                time.sleep(0.1)

    def tearDown(self):
        self.p.terminate()
        try:
            self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.p.kill()
        self.tmp.cleanup()

    def post(self, body, raw=None):
        data = raw if raw is not None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/text-thing", data=data,
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_a_german_request_writes_its_file_atomically(self):
        code, out = self.post({"text": "  eine Laterne  "})
        self.assertEqual(code, 200)
        self.assertEqual(out["ok"], True)
        f = self.root / "frames" / "requests" / f"{out['id']}.json"
        req = json.loads(f.read_text())
        self.assertEqual(req["text"], "eine Laterne")
        self.assertEqual(req["lang"], "de")
        self.assertEqual(req["id"], out["id"])
        self.assertTrue(req["requested_at"].endswith("Z"))
        self.assertEqual([p.name for p in f.parent.glob(".*.tmp")], [])

    def test_an_english_request_is_marked_english(self):
        code, out = self.post({"text": "a lantern"})
        self.assertEqual(code, 200)
        req = json.loads((self.root / "frames" / "requests" / f"{out['id']}.json").read_text())
        self.assertEqual(req["lang"], "en")

    def test_requests_in_the_same_second_get_different_ids(self):
        _, a = self.post({"text": "a lantern"})
        _, b = self.post({"text": "eine Laterne"})
        self.assertNotEqual(a["id"], b["id"])
        self.assertTrue((self.root / "frames" / "requests" / f"{b['id']}.json").exists())

    def test_missing_empty_and_too_long_text_are_400(self):
        for body in ({}, {"text": ""}, {"text": "   "}, {"text": "x" * 81}, {"text": 3}):
            code, out = self.post(body)
            self.assertEqual(code, 400, body)
            self.assertEqual(out, {"ok": False, "error": "say what to build (1-80 characters)"})
        self.assertFalse((self.root / "frames" / "requests").exists())

    def test_bad_json_is_400(self):
        code, out = self.post(None, raw=b"not json")
        self.assertEqual(code, 400)
        self.assertEqual(out["ok"], False)

    def test_control_characters_are_flattened_not_kept(self):
        code, out = self.post({"text": "ein\nHaus\x00"})
        self.assertEqual(code, 200)
        req = json.loads((self.root / "frames" / "requests" / f"{out['id']}.json").read_text())
        self.assertEqual(req["text"], "ein Haus")


if __name__ == "__main__":
    unittest.main()
