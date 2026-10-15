"""Serve the camera folder on localhost:8765 with caching disabled,
so the viewer always picks up the latest world.js and camera frames."""
import functools
import http.server
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(
    ("127.0.0.1", 8765), functools.partial(NoCache, directory=str(ROOT))
).serve_forever()
