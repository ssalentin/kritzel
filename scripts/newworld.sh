#!/usr/bin/env bash
# Archive the current paper world and start an empty one.
# usage: scripts/newworld.sh [name]   → worlds/<name>-YYYYmmdd-HHMM/ (viewable at /worlds/<dir>/)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:-welt}-$(date +%Y%m%d-%H%M)
dest="$root/worlds/$name"
mkdir -p "$dest"
for f in index.html world.js sim.js sim-extra.js island.js characters.js sound.js; do
  [ -f "$root/viewer/$f" ] && cp "$root/viewer/$f" "$dest/"
done
cp -r "$root/viewer/things" "$dest/things"
rm -f "$root"/viewer/things/*.js     # the live page notices the empty things/ and plays the new-world animation
echo "archived to worlds/$name"
