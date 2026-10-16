#!/usr/bin/env bash
# One command for the whole pipeline on this machine: viewer server + capture + generate.
# usage: scripts/dev.sh        (each part starts only if it is not running yet; logs in the repo root)
# The camera comes from camera.json (choose it with the viewer's 📷 picker).
# Stop: pkill -f '^[^ ]*python3 (-u )?scripts/capture\.py'; pkill -f '^[^ ]*node generate/generate\.mjs --watch'
# (patterns anchored at the program, so they never match a shell whose command line contains the text)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if ! curl -s -o /dev/null http://127.0.0.1:8765/viewer/; then
  setsid python3 viewer/serve.py >serve.log 2>&1 < /dev/null &
  for _ in $(seq 20); do curl -s -o /dev/null http://127.0.0.1:8765/viewer/ && break; sleep 0.25; done
fi
echo "viewer:   http://127.0.0.1:8765/viewer/"

if ! pgrep -f '^[^ ]*python3 (-u )?scripts/capture\.py' >/dev/null; then
  setsid python3 -u scripts/capture.py >>capture.log 2>&1 < /dev/null &
fi
echo "capture:  frames/settled/  (log: capture.log)"

if ! pgrep -f '^[^ ]*node .*generate\.mjs --watch' >/dev/null; then
  [ -d generate/node_modules ] || (cd generate && npm install --no-audit --no-fund >/dev/null)
  mkdir -p frames/generated
  setsid node generate/generate.mjs --watch >>generate.log 2>&1 < /dev/null &
fi
echo "generate: viewer/things/  (log: generate.log, reports: frames/generated/)"
