#!/usr/bin/env bash
# Archive the current paper world and start an empty one.
# usage: scripts/newworld.sh [name]   → worlds/<name>-YYYYmmdd-HHMM/ (viewable at /worlds/<dir>/)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:-welt}-$(date +%Y%m%d-%H%M)
dest="$root/worlds/$name"
render=3d
if [ -f "$root/world-mode.json" ]; then
  render=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("render", "3d"))' "$root/world-mode.json")
fi
case "$render" in 3d|pixel) ;; *) render=3d ;; esac
mkdir -p "$dest"
# the whole engine: index.html statically imports several modules, and one missing import
# would keep an archived world from loading at all
cp "$root"/viewer/*.js "$root"/viewer/index.html "$dest"/
[ -f "$root/viewer/favicon.svg" ] && cp "$root/viewer/favicon.svg" "$dest"/
cp -r "$root/viewer/things" "$dest/things"
if [ -d "$root/viewer/sounds" ]; then cp -r "$root/viewer/sounds" "$dest/sounds"; fi   # the rendered bank (sound.js loads it next to the page)
if [ -d "$root/viewer/pixel" ]; then cp -r "$root/viewer/pixel" "$dest/pixel"; fi      # the pixel app and its generated scene
printf '{"render":"%s"}\n' "$render" > "$dest/world-mode.json"   # an archive reopens in the mode it was made in
rm -f "$root"/viewer/things/*.js     # both mode folders are empty: the next drawing belongs to the active mode only
echo '{}' > "$root"/viewer/things/placement.json   # a new world: every thing that comes is placed (the old file is archived)
mkdir -p "$root/viewer/pixel/things"
find "$root/viewer/pixel/things" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -delete
if [ -d "$root/viewer/pixel/sprites" ]; then
  find "$root/viewer/pixel/sprites" -maxdepth 1 -type f ! -name 'fallback-*.png' -delete
fi
if [ -f "$root/viewer/pixel/scenes/book.png" ]; then
  cp "$root/viewer/pixel/scenes/book.png" "$root/viewer/pixel/scenes/kritzel.png"
fi
echo "archived to worlds/$name"
