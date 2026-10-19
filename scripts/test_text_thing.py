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
from concurrent.futures import ThreadPoolExecutor
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

    def post(self, body, raw=None, same_site=True):
        data = raw if raw is not None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if same_site:
            headers["X-Kritzel"] = "1"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/text-thing", data=data,
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_a_german_request_writes_its_file_atomically(self):
        code, out = self.post({"text": "  eine Laterne  "})
        self.assertEqual(code, 200)
        self.assertEqual(out["ok"], True)
        self.assertTrue(out["id"].startswith("text-"))
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

    def test_concurrent_posts_all_get_their_own_file(self):
        with ThreadPoolExecutor(24) as ex:
            out = list(ex.map(lambda i: self.post({"text": f"ding {i}"}), range(24)))
        ids = [b["id"] for code, b in out if code == 200]
        self.assertEqual(len(ids), 24)
        self.assertEqual(len(set(ids)), 24)
        self.assertEqual(len(list((self.root / "frames" / "requests").glob("*.json"))), 24)

    def test_a_post_without_the_same_site_header_is_forbidden(self):
        code, out = self.post({"text": "a lantern"}, same_site=False)
        self.assertEqual(code, 403)
        self.assertEqual(out, {"error": "forbidden"})
        self.assertFalse((self.root / "frames" / "requests").exists())

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

    def test_the_director_route_survives_next_to_text_thing(self):
        """The merge with camera-select: both POST routes and the shared same-site guard are in the real server."""
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/think", timeout=5) as r:
            self.assertEqual(r.status, 200)
            self.assertIn("on", json.load(r))
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/think", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json", "X-Kritzel": "1"})
        with urllib.request.urlopen(req, timeout=5) as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(json.load(r), {})
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/think", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(e.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
