#!/usr/bin/env bash
# Start the paper world: local web server (no caching) + live camera window.
# usage: scripts/start.sh [video device, default /dev/video2]
# Then open http://127.0.0.1:8765/viewer/  — archived worlds live under /worlds/<name>/.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
dev=${1:-/dev/video2}
cd "$root"

if ! curl -s -o /dev/null http://127.0.0.1:8765/viewer/; then
  setsid python3 viewer/serve.py >/dev/null 2>&1 &
  echo "web server: http://127.0.0.1:8765/viewer/"
fi

if ! pgrep -x mpv >/dev/null; then
  rm -f mpv.sock
  # MJPEG 1080p30; the lavfi chain corrects very warm room light (white balance) and smooths chroma noise.
  # The IPC socket lets the watcher grab frames while the window is open.
  setsid mpv --title="IPEVO V4K" --input-ipc-server="$root/mpv.sock" --profile=low-latency --untimed \
    --demuxer-lavf-format=video4linux2 \
    --demuxer-lavf-o=input_format=mjpeg,video_size=1920x1080,framerate=30 \
    '--vf=lavfi=[format=rgb24,lutrgb=r=clipval*1.25:g=clipval*1.82:b=clipval*7.7,format=yuv444p,gblur=sigma=10:planes=6]' \
    "av://v4l2:$dev" >mpv.log 2>&1 &
  echo "camera window: $dev"
fi
