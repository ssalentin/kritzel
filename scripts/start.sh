#!/usr/bin/env bash
# Start the paper world: local web server (no caching), camera server, live camera window.
# usage: scripts/start.sh [camera, default video2]
# Then open http://127.0.0.1:8765/viewer/  — archived worlds live under /worlds/<name>/.
# The camera server is the only program that opens the camera; the mpv window and the
# viewer's camera picker both watch its stream, so they can run at the same time.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cam=${1:-video2}
cam=${cam#/dev/}
cd "$root"

if ! curl -s -o /dev/null http://127.0.0.1:8765/viewer/; then
  setsid python3 viewer/serve.py >/dev/null 2>&1 &
  echo "web server: http://127.0.0.1:8765/viewer/"
fi

if ! curl -s -o /dev/null http://127.0.0.1:8766/cameras.json; then
  setsid python3 scripts/camera_server.py >camera.log 2>&1 &
  for _ in $(seq 20); do curl -s -o /dev/null http://127.0.0.1:8766/cameras.json && break; sleep 0.25; done
  echo "camera server: http://127.0.0.1:8766/cameras.json"
fi

if ! pgrep -x mpv >/dev/null; then
  rm -f mpv.sock
  # MJPEG 1080p30 from the camera server; the lavfi chain corrects very warm room light (white balance)
  # and smooths chroma noise. The IPC socket lets the watcher grab frames while the window is open.
  setsid mpv --title="IPEVO V4K" --input-ipc-server="$root/mpv.sock" --profile=low-latency --untimed \
    '--vf=lavfi=[format=rgb24,lutrgb=r=clipval*1.25:g=clipval*1.82:b=clipval*7.7,format=yuv444p,gblur=sigma=10:planes=6]' \
    "http://127.0.0.1:8766/stream/$cam.mjpg" >mpv.log 2>&1 &
  echo "camera window: $cam"
fi
