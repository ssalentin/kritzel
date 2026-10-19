"""Tests for POST /api/can against a fake Jev upstream.

    python3 -m unittest scripts/test_can.py

No network and no key: the fake answers yes for a Keks and no for a Truhe, exactly as the story
model would. The proxy, the prompt, the route and the failure contract are the real code.
"""
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "viewer"))
import serve  # noqa: E402

MAUS = {"name": "Maus", "kind": "mouse", "bulk": 0.25}
KEKS = {"name": "Keks", "bulk": 0.3, "contents": ""}
TRUHE = {"name": "große Truhe mit Gold", "bulk": 1.6, "contents": "Gold"}
KIND = {"name": "Kind", "kind": "person", "bulk": 0.9}


class Upstream(BaseHTTPRequestHandler):
    mode = "ok"
    calls = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n))
        Upstream.calls.append(body)
        if Upstream.mode == "timeout":
            time.sleep(2.6)
        if Upstream.mode == "500":
            self.send_response(500)
            self.end_headers()
            return
        state = body.get("state") or {}
        thing = (state.get("thing") or {}).get("name", "")
        actor = (state.get("actor") or {}).get("name", "")
        choice = "yes" if "Keks" in thing or ("Truhe" in thing and actor == "Kind") else "no"
        out = {qid: {"type": "choice", "choice": choice, "confidence": 0.9}
               for qid in body.get("questions", {})}
        payload = json.dumps({"answers": out, "usage": {"cost": 0.00004, "input_tokens": 180, "output_tokens": 12}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except OSError:
            pass

    def log_message(self, *args):
        pass


class Can(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.up.server_port}/api/alpha/decisions"

    @classmethod
    def tearDownClass(cls):
        cls.up.shutdown()

    def setUp(self):
        Upstream.mode, Upstream.calls = "ok", []
        serve.CAN_CACHE.clear()

    def env(self, **kw):
        base = {"KRITZEL_THINK": "1", "OPENROUTER_API_KEY": "test-key", "KRITZEL_THINK_URL": self.url,
                "KRITZEL_THINK_MODEL": "typesafe/jev-1.14"}
        base.update(kw)
        return mock.patch.dict(os.environ, base, clear=False)

    def ask(self, actor, thing):
        with self.env():
            return serve.can(actor, thing)

    def test_a_mouse_can_take_a_cookie(self):
        out = self.ask(MAUS, KEKS)
        self.assertEqual(out["ok"], True)
        self.assertEqual(out["can"], True)
        self.assertTrue(out["why"])
        body = Upstream.calls[0]
        self.assertEqual(set(body["questions"]), {"can"})
        self.assertEqual(body["state"]["actor"], MAUS)
        self.assertEqual(body["state"]["thing"], KEKS)
        self.assertEqual(set(body["questions"]["can"]["criteria"]), {"yes", "no"})

    def test_a_mouse_cannot_take_the_chest(self):
        out = self.ask(MAUS, TRUHE)
        self.assertEqual((out["ok"], out["can"]), (True, False))
        self.assertIn("zu groß", out["why"])

    def test_a_person_can_take_the_chest(self):
        out = self.ask(KIND, TRUHE)
        self.assertEqual((out["ok"], out["can"]), (True, True))
        self.assertEqual(Upstream.calls[0]["state"]["actor"], KIND)

    def test_off_or_without_a_key_is_not_an_answer(self):
        for env in ({"KRITZEL_THINK": "0"}, {"OPENROUTER_API_KEY": ""}):
            Upstream.calls.clear()
            with self.env(**env):
                self.assertFalse(serve.can(MAUS, KEKS)["ok"])
            self.assertEqual(Upstream.calls, [])

    def test_timeout_is_not_an_answer(self):
        Upstream.mode = "timeout"
        started = time.time()
        self.assertFalse(self.ask(MAUS, KEKS)["ok"])
        self.assertLess(time.time() - started, 2.8)

    def test_upstream_error_is_not_an_answer(self):
        Upstream.mode = "500"
        self.assertFalse(self.ask(MAUS, KEKS)["ok"])

    def test_a_pair_is_cached(self):
        self.ask(MAUS, KEKS)
        self.ask(MAUS, KEKS)
        self.assertEqual(len(Upstream.calls), 1)


class Routes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: serve.Handler(*a, directory=str(ROOT), **k))
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()

    def post(self, body, header=False):
        req = urllib.request.Request(self.base + "/api/can", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", **({"X-Kritzel": "1"} if header else {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_needs_the_viewer_header(self):
        status, _ = self.post({"actor": MAUS, "thing": KEKS})
        self.assertEqual(status, 403)

    def test_missing_actor_or_thing_is_a_400(self):
        self.assertEqual(self.post({"actor": MAUS}, header=True)[0], 400)
        self.assertEqual(self.post({"actor": {"name": ""}, "thing": KEKS}, header=True)[0], 400)

    def test_off_answers_not_ok(self):
        with mock.patch.dict(os.environ, {"KRITZEL_THINK": "0", "OPENROUTER_API_KEY": "test-key"}, clear=False):
            status, body = self.post({"actor": MAUS, "thing": KEKS}, header=True)
        self.assertEqual(status, 200)
        self.assertEqual(body["ok"], False)


if __name__ == "__main__":
    unittest.main()
