#!/usr/bin/env bash
# Archive the current paper world and start an empty one.
# usage: scripts/newworld.sh [name]   → worlds/<name>-YYYYmmdd-HHMM/ (viewable at /worlds/<dir>/)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:-welt}-$(date +%Y%m%d-%H%M)
dest="$root/worlds/$name"
mkdir -p "$dest"
# the whole engine: index.html statically imports several modules, and one missing import
# would keep an archived world from loading at all
cp "$root"/viewer/*.js "$root"/viewer/index.html "$dest"/
[ -f "$root/viewer/favicon.svg" ] && cp "$root/viewer/favicon.svg" "$dest"/
cp -r "$root/viewer/things" "$dest/things"
rm -f "$root"/viewer/things/*.js     # the live page notices the empty things/ and plays the new-world animation
echo '{}' > "$root"/viewer/things/placement.json   # a new world: every thing that comes is placed (the old file is archived)
echo "archived to worlds/$name"
