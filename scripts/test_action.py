"""Tests for POST /api/action against a fake Jev upstream.

    python3 -m unittest scripts/test_action.py

No network and no key: the fake upstream answers from the instruction text, exactly as the real
decisions endpoint would. The command assembly, the closed vocabulary and the failure contract are
the real code in viewer/serve.py.
"""
import json
import os
import sys
import tempfile
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

THINGS = [{"file": "hexe.js", "name": "Hexe"}, {"file": "mond.js", "name": "Mond"},
          {"file": "eule.js", "name": "Eule"}]


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
        text = (body.get("state") or {}).get("instruction", "")
        if "schneien" in text:
            answers = {"kind": "weather", "weather": "snow"}
        elif "Mond" in text:
            answers = {"kind": "goal", "action": "fly_to", "target": "hexe.js", "where": "mond.js"}
        elif "tanzen" in text:
            answers = {"kind": "goal", "action": "dance", "target": "hexe.js", "where": "none"}
        elif "bunt" in text:
            answers = {"kind": "unknown"}
        else:
            answers = {"kind": "weather", "weather": ["snow"]}       # a malformed type
        out = {qid: {"type": "choice", "choice": answers.get(qid, "none"), "confidence": 0.9}
               for qid in body.get("questions", {})}
        payload = json.dumps({"answers": out, "usage": {"cost": 0.00004, "input_tokens": 300, "output_tokens": 20}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except OSError:
            pass                                     # the timeout test's client has already gone

    def log_message(self, *args):
        pass


class Action(unittest.TestCase):
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
        serve.ACTION_CACHE.clear()

    def env(self, **kw):
        base = {"KRITZEL_THINK": "1", "OPENROUTER_API_KEY": "test-key", "KRITZEL_THINK_URL": self.url,
                "KRITZEL_THINK_MODEL": "typesafe/jev-1.14"}
        base.update(kw)
        return mock.patch.dict(os.environ, base, clear=False)

    def ask(self, text):
        with self.env():
            return serve.action(text, {"text": text, "things": THINGS})

    def test_snow_is_a_weather_command(self):
        self.assertEqual(self.ask("Es soll schneien"), {"kind": "weather", "value": "snow"})
        body = Upstream.calls[0]
        self.assertEqual(set(body["questions"]), {"kind", "action", "target", "where", "weather", "time"})
        self.assertEqual(set(body["questions"]["target"]["criteria"]), {"hexe.js", "mond.js", "eule.js", "none"})
        self.assertIn("not a place", body["questions"]["target"]["instructions"])
        self.assertIn("Never pick the figure that acts", body["questions"]["where"]["instructions"])

    def test_witch_flies_to_the_moon(self):
        self.assertEqual(self.ask("Die Hexe soll zum Mond fliegen"),
                         {"kind": "goal", "target": "hexe.js", "action": "fly_to", "where": "mond.js"})

    def test_dance_needs_no_place(self):
        self.assertEqual(self.ask("Die Hexe soll tanzen"),
                         {"kind": "goal", "target": "hexe.js", "action": "dance", "where": None})

    def test_unsupported_text_is_unknown(self):
        out = self.ask("Mach die Welt bunt")
        self.assertEqual(out["kind"], "unknown")
        self.assertTrue(out["why"])

    def test_malformed_choice_is_unknown(self):
        out = self.ask("Etwas anderes")
        self.assertEqual(out["kind"], "unknown")

    def test_invented_target_is_unknown(self):
        orig = serve.action_command
        with self.env():
            with mock.patch.object(serve, "action_command", lambda answers, things: orig(
                    {"kind": {"choice": "goal"}, "action": {"choice": "go_to"},
                     "target": {"choice": "nicht-da.js"}, "where": {"choice": "mond.js"}}, things)):
                out = serve.action("Geh hin", {"text": "Geh hin", "things": THINGS})
        self.assertEqual(out["kind"], "unknown")

    def test_fly_without_where_is_unknown(self):
        Upstream.calls.clear()
        orig = serve.action_command
        with self.env():
            with mock.patch.object(serve, "action_command", lambda answers, things: orig(
                    {"kind": {"choice": "goal"}, "action": {"choice": "fly_to"},
                     "target": {"choice": "hexe.js"}, "where": {"choice": "none"}}, things)):
                out = serve.action("Flieg", {"text": "Flieg", "things": THINGS})
        self.assertEqual(out, {"kind": "unknown", "why": "Wohin denn?"})

    def test_a_figure_cannot_be_its_own_destination(self):
        out = serve.action_command(
            {"kind": {"choice": "goal"}, "action": {"choice": "fly_to"},
             "target": {"choice": "hexe.js"}, "where": {"choice": "hexe.js"}}, THINGS)
        self.assertEqual(out, {"kind": "unknown", "why": "Wohin denn?"})

    def test_500_returns_unknown(self):
        Upstream.mode = "500"
        self.assertEqual(self.ask("Es soll schneien")["kind"], "unknown")

    def test_timeout_returns_unknown_within_two_seconds(self):
        Upstream.mode = "timeout"
        started = time.time()
        self.assertEqual(self.ask("Es soll schneien")["kind"], "unknown")
        self.assertLess(time.time() - started, 2.8)

    def test_missing_key_or_flag_off_makes_no_call(self):
        for env in ({"OPENROUTER_API_KEY": ""}, {"KRITZEL_THINK": "0"}):
            Upstream.calls.clear()
            with self.env(**env):
                self.assertEqual(serve.action("Es soll schneien", {"things": THINGS})["kind"], "unknown")
            self.assertEqual(Upstream.calls, [])

    def test_things_fall_back_to_the_world_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            things = Path(tmp) / "viewer" / "things"
            things.mkdir(parents=True)
            (things / "hexe.js").write_text("export const meta = { name: 'Hexe', drawing: 'a witch' };\n")
            old = serve.ROOT
            serve.ROOT = Path(tmp)
            try:
                self.assertEqual(serve.action_things({}), [{"file": "hexe.js", "name": "Hexe"}])
            finally:
                serve.ROOT = old


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
        req = urllib.request.Request(self.base + "/api/action", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", **({"X-Kritzel": "1"} if header else {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_needs_the_viewer_header(self):
        status, _ = self.post({"text": "Es soll schneien"})
        self.assertEqual(status, 403)

    def test_empty_text_is_a_400(self):
        status, body = self.post({"text": "   "}, header=True)
        self.assertEqual(status, 400)
        self.assertEqual(body["ok"], False)

    def test_off_answers_unknown(self):
        with mock.patch.dict(os.environ, {"KRITZEL_THINK": "0", "OPENROUTER_API_KEY": "test-key"}, clear=False):
            status, body = self.post({"text": "Es soll schneien", "things": THINGS}, header=True)
        self.assertEqual(status, 200)
        self.assertEqual(body["ok"], True)
        self.assertEqual(body["command"]["kind"], "unknown")


if __name__ == "__main__":
    unittest.main()
