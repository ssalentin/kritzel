#!/usr/bin/env bash
# Render Kritzel's small sound bank with earshot (https://github.com/Leonxlnx/earshot).
#
#   scripts/make-sounds.sh
#
# earshot keeps its effects as code; this renders the nine roles the viewer uses, trims them to
# short mono Ogg files and writes viewer/sounds/. earshot is a build-time tool only: nothing here
# is needed at runtime, and the browser never runs earshot. The checkout is pinned to a commit so
# the same bank renders again later.
#
# Needs python3, git and ffmpeg (with libvorbis). Network is used for the pinned clone and pip.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/viewer/sounds"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# main of Leonxlnx/earshot when the bank was picked; v0.3.0 was not tagged yet.
earshot_commit=925ebe56a1b755e5d354ab642bb8f344440cfa9c
echo "earshot: $earshot_commit"
git clone -q https://github.com/Leonxlnx/earshot "$work/earshot"
git -C "$work/earshot" checkout -q "$earshot_commit"
python3 -m venv "$work/venv"
# pinned with the bank: a different numpy/scipy/librosa can move the rendered samples
"$work/venv/bin/pip" install -q --disable-pip-version-check \
  numpy==2.4.6 scipy==1.17.1 soundfile==0.14.0 librosa==0.11.0 pyloudnorm==0.2.0
echo "ffmpeg: $(ffmpeg -version | head -1)"   # Ogg q4 (libvorbis); the bank was rendered with 5.1.9

mkdir -p "$out"
render() {   # role → earshot id
  echo "  $1 <- $2"
  PYTHONPATH="$work/earshot" "$work/venv/bin/python" -m earshot sfx render "$2" --peak -5 -o "$work/$1.wav" >/dev/null
  # -5 dBFS leaves headroom for the Ogg encoder's overshoot; every file stays below -1 dBTP.
  ffmpeg -y -loglevel error -i "$work/$1.wav" -ac 1 -ar 48000 -c:a libvorbis -q:a 4 "$out/$1.ogg"
}

render arrival       pop/0
render page-turn     swipe/paper
render tap           tap/soft
render giggle        pro_pop/double
render sparkle       pro_shimmer/m1
render rain          pro_whoosh_big/windy
render thunder       pro_impact/rumble
render new-world     notify/m1
render typed-arrival pro_notify/ding_2045

echo "measure (true peak must stay below -1 dBFS):"
for f in "$out"/*.ogg; do
  PYTHONPATH="$work/earshot" "$work/venv/bin/python" -m earshot measure "$f" | head -1
done

echo "bank size:"
du -ch "$out"/*.ogg | tail -1
