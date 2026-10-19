"""Tests for the Jev director proxy in viewer/serve.py, against a fake upstream.

    python3 -m unittest scripts/test_think.py

No network, no key: the upstream is a local HTTP server, and the tests only check what the proxy
sends and how it turns an answer, a timeout, an error or a switched-off director into {}. The
external service is the only thing faked; the proxy code is the real one.
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


class Upstream(BaseHTTPRequestHandler):
    """The OpenRouter decisions endpoint, as far as the proxy can tell."""
    mode = "ok"
    choice = "rest"
    calls = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n))
        Upstream.calls.append({"body": body, "auth": self.headers.get("Authorization")})
        if Upstream.mode == "timeout":
            time.sleep(2.6)
        if Upstream.mode == "500":
            self.send_response(500)
            self.end_headers()
            return
        answers = {qid: {"type": "choice", "choice": Upstream.choice,
                         "probabilities": {}, "confidence": 0.9}
                   for qid in body.get("questions", {})}
        if Upstream.mode == "extra":                  # answers for people who were never asked
            answers["stranger"] = {"type": "choice", "choice": "chat", "confidence": 1}
            answers["__proto__"] = {"type": "choice", "choice": "chat", "confidence": 1}
        out = json.dumps({"answers": answers, "usage": {"cost": 0.0000217, "input_tokens": 500, "output_tokens": 80}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


def state(*ids):
    return {"scene": {"night": 0.2, "weather": ["rain"]},
            "actors": [{"id": i, "name": i.title(), "kind": "person", "mood": "lonely",
                        "needs": ["lonely 40%"], "nearby": [{"name": "Schaf", "kind": "thing", "distance": 2.1}]} for i in ids]}


class Think(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.up.server_port}/api/alpha/decisions"

    @classmethod
    def tearDownClass(cls):
        cls.up.shutdown()

    def setUp(self):
        Upstream.mode, Upstream.choice, Upstream.calls = "ok", "rest", []
        serve.THINK_CACHE.clear()

    def env(self, **kw):
        base = {"KRITZEL_THINK": "1", "OPENROUTER_API_KEY": "test-key", "KRITZEL_THINK_URL": self.url,
                "KRITZEL_THINK_MODEL": "typesafe/jev-1.14"}
        base.update(kw)
        return mock.patch.dict(os.environ, base, clear=False)

    def test_answers_become_goals_with_usage(self):
        with self.env():
            out = serve.think(state("bana", "mika"))
        self.assertEqual({k: v["goal"] for k, v in out["goals"].items()}, {"bana": "rest", "mika": "rest"})
        self.assertAlmostEqual(out["usage"]["cost"], 0.0000217)
        self.assertEqual(len(Upstream.calls), 1)
        call = Upstream.calls[0]
        self.assertEqual(call["auth"], "Bearer test-key")
        self.assertEqual(call["body"]["model"], "typesafe/jev-1.14")
        self.assertEqual(set(call["body"]["questions"]), {"bana", "mika"})
        q = call["body"]["questions"]["bana"]
        self.assertEqual(q["type"], "choice")
        self.assertEqual(set(q["criteria"]), set(serve.THINK_GOALS))
        self.assertIn("Bana", json.dumps(q["instructions"]))
        self.assertEqual(call["body"]["state"]["scene"]["weather"], ["rain"])

    def test_unknown_choice_is_dropped(self):
        Upstream.choice = "fly-to-the-moon"
        with self.env():
            out = serve.think(state("bana"))
        self.assertEqual(out, {})

    def test_malformed_choice_type_returns_empty(self):
        for bad in (["chat"], {"chat": 1}):        # a 200 with the wrong type, not a goal
            Upstream.choice = bad
            with self.env():
                self.assertEqual(serve.think(state("bana")), {})

    def test_answers_for_other_ids_are_dropped(self):
        Upstream.mode = "extra"
        with self.env():
            out = serve.think(state("bana"))
        self.assertEqual(set(out["goals"]), {"bana"})

    def test_500_returns_empty(self):
        Upstream.mode = "500"
        with self.env():
            self.assertEqual(serve.think(state("bana")), {})

    def test_timeout_returns_empty_within_the_two_seconds(self):
        Upstream.mode = "timeout"
        started = time.time()
        with self.env():
            self.assertEqual(serve.think(state("bana")), {})
        self.assertLess(time.time() - started, 2.8)

    def test_missing_key_makes_no_call(self):
        with self.env(OPENROUTER_API_KEY=""):
            self.assertEqual(serve.think(state("bana")), {})
        self.assertEqual(Upstream.calls, [])

    def test_flag_off_makes_no_call(self):
        with self.env(KRITZEL_THINK="0"):
            self.assertEqual(serve.think(state("bana")), {})
        self.assertEqual(Upstream.calls, [])
        with self.env(KRITZEL_THINK="off"):
            self.assertEqual(serve.think_config()["on"], False)
        self.assertEqual(Upstream.calls, [])

    def test_bad_input_makes_no_call(self):
        with self.env():
            self.assertEqual(serve.think({"actors": "nope"}), {})
            self.assertEqual(serve.think({"actors": []}), {})
        self.assertEqual(Upstream.calls, [])

    def test_same_state_within_three_seconds_is_cached(self):
        with self.env():
            serve.think(state("bana"))
            serve.think(state("bana"))
        self.assertEqual(len(Upstream.calls), 1)

    def test_one_request_in_flight_at_a_time(self):
        with self.env():
            serve.THINK_LOCK.acquire()
            try:
                self.assertEqual(serve.think(state("bana")), {})
            finally:
                serve.THINK_LOCK.release()
        self.assertEqual(Upstream.calls, [])


class Routes(unittest.TestCase):
    """The HTTP surface: the feature switch, the same-site header, and {} when off."""

    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: serve.Handler(*a, directory=str(ROOT), **k))
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}"
        cls.up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.up.shutdown()

    def call(self, method, path, body=None, header=False):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", **({"X-Kritzel": "1"} if header else {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_get_says_off_by_default(self):
        with mock.patch.dict(os.environ, {"KRITZEL_THINK": "0", "OPENROUTER_API_KEY": "test-key"}, clear=False):
            status, body = self.call("GET", "/api/think")
        self.assertEqual(status, 200)
        self.assertEqual(body["on"], False)
        self.assertEqual(body["model"], "typesafe/jev-1.14")

    def test_post_needs_the_viewer_header(self):
        status, _ = self.call("POST", "/api/think", state("bana"))
        self.assertEqual(status, 403)

    def test_post_off_answers_empty(self):
        with mock.patch.dict(os.environ, {"KRITZEL_THINK": "0", "OPENROUTER_API_KEY": "test-key"}, clear=False):
            status, body = self.call("POST", "/api/think", state("bana"), header=True)
        self.assertEqual(status, 200)
        self.assertEqual(body, {})

    def test_post_with_a_malformed_upstream_reply_answers_empty(self):
        Upstream.mode, Upstream.choice, Upstream.calls = "ok", ["chat"], []
        serve.THINK_CACHE.clear()
        env = {"KRITZEL_THINK": "1", "OPENROUTER_API_KEY": "test-key",
               "KRITZEL_THINK_URL": f"http://127.0.0.1:{self.up.server_port}/api/alpha/decisions"}
        with mock.patch.dict(os.environ, env, clear=False):
            status, body = self.call("POST", "/api/think", state("bana"), header=True)
        self.assertEqual(status, 200)
        self.assertEqual(body, {})


if __name__ == "__main__":
    unittest.main()
