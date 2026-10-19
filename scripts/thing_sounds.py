#!/usr/bin/env python3
"""A short sound for each drawn thing, rendered with earshot's DSP layer.

    scripts/thing_sounds.py --ensure                      # once: clone earshot + venv
    scripts/thing_sounds.py --name Drache --kind actor --move fly \
        --seed drache --out viewer/sounds/things/drache.ogg

earshot (https://github.com/Leonxlnx/earshot) writes sounds as code. This uses only its DSP
building blocks (earshot.forge.dsp) at the pinned commit; no CLAP critic, torch, model or API
key. The same name, kind, move and seed always render the same bytes on this machine.

Families: person, fly, swim, walk, plant, thing, building, vehicle, light, magic. A name is
mapped by German/English words first, then the movement, then the kind; unknown scenery falls
back to a knock (thing) and an unknown actor to footsteps (walk).

The earshot checkout and venv live in .kritzel/ (gitignored). Without them the script exits 2
with the reason; generate treats that as "no sound" and still writes the thing.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARSHOT_REPO = "https://github.com/Leonxlnx/earshot"
EARSHOT_COMMIT = "925ebe56a1b755e5d354ab642bb8f344440cfa9c"
EARSHOT_DIR = os.environ.get("KRITZEL_EARSHOT_DIR") or os.path.join(ROOT, ".kritzel", "earshot")
VENV_DIR = os.environ.get("KRITZEL_EARSHOT_VENV") or os.path.join(ROOT, ".kritzel", "earshot-venv")
PINS = ("numpy==2.4.6", "scipy==1.17.1", "soundfile==0.14.0")

FAMILIES = ("person", "fly", "swim", "walk", "plant", "thing", "building", "vehicle", "light", "magic", "weather")
LENGTHS = {"person": 0.5, "fly": 0.55, "swim": 0.5, "walk": 0.55, "plant": 0.7,
           "thing": 0.4, "building": 0.75, "vehicle": 0.75, "light": 0.7, "magic": 0.75, "weather": 0.65}

# Words are checked in this order, so a compound keeps the object it names (Baumhaus is a
# building, not a tree). Short words match whole words only; longer ones also inside a compound
# (Taschenlampe, Schmetterling).
WORDS = {
    "weather": ("wolke", "cloud", "regen", "rain", "schnee", "snow", "wind", "sturm", "storm",
                "nebel", "fog", "regenbogen", "rainbow", "wasserfall", "waterfall", "wasser", "water"),
    "light": ("lampe", "lamp", "laterne", "lantern", "kerze", "candle", "feuer", "fire",
              "licht", "light", "sonne", "sun", "mond", "moon", "stern", "star", "fackel", "torch"),
    "vehicle": ("auto", "car", "bus", "zug", "train", "boot", "boat", "schiff", "ship",
                "flugzeug", "plane", "rakete", "rocket", "fahrrad", "bike", "roller", "traktor",
                "tractor", "lastwagen", "truck"),
    "building": ("haus", "house", "hütte", "hut", "schloss", "castle", "turm", "tower", "zelt",
                 "tent", "brücke", "bridge", "gefängnis", "jail", "mauer", "wall", "zaun", "fence",
                 "kirche", "church", "zimmer", "room", "garage", "höhle", "cave", "baumhaus", "vogelhaus",
                 "hundehütte", "bienenstock"),
    "fly": ("vogel", "bird", "schmetterling", "butterfly", "fledermaus", "bat", "biene", "bee",
            "libelle", "dragonfly", "fliege", "fly", "eule", "owl", "papagei", "parrot", "ente", "duck"),
    "swim": ("fisch", "fish", "wal", "whale", "hai", "shark", "krabbe", "crab", "walross", "seal",
             "qualle", "jellyfish", "krake", "octopus", "oktopus", "schildkröte", "turtle", "delphin",
             "dolphin", "pinguin", "penguin"),
    "plant": ("baum", "tree", "blume", "flower", "gras", "grass", "strauch", "bush", "pilz",
              "mushroom", "rose", "tulpe", "tulip", "blatt", "leaf", "kaktus", "cactus", "wald", "forest"),
    "thing": ("tisch", "table", "stuhl", "chair", "bett", "bed", "schrank", "cupboard", "sofa",
              "regal", "shelf", "kiste", "box", "karton", "stift", "pencil", "pen", "buch", "book",
              "stein", "rock", "stone", "berg", "mountain", "fels", "cliff", "insel", "island",
              "ball", "spielzeug", "toy", "besen", "broom", "topf", "pot", "tasse", "cup", "handschuh"),
    "person": ("mensch", "person", "mann", "man", "frau", "woman", "kind", "child", "junge", "boy",
               "mädchen", "girl", "vater", "father", "mutter", "mother", "oma", "opa", "baby",
               "strichfigur", "figur", "figure", "ritter", "knight", "pirat", "pirate", "prinzessin",
               "princess", "clown", "hand", "freund", "friend"),
    "magic": ("hexe", "witch", "drache", "dragon", "zauber", "magic", "gespenst", "ghost",
              "monster", "vampir", "vampire", "einhorn", "unicorn", "fee", "fairy", "riese",
              "giant", "troll", "wolf", "werwolf", "werewolf", "alien", "roboter", "robot"),
}
GROWL = ("drache", "dragon", "monster", "gespenst", "ghost", "vampir", "vampire", "riese",
         "giant", "troll", "wolf", "werwolf", "werewolf")
KIND_FAMILY = {
    "person": "person", "mensch": "person", "figure": "person",
    "fly": "fly", "animal/fly": "fly", "vogel": "fly", "bird": "fly",
    "swim": "swim", "animal/swim": "swim", "fish": "swim",
    "walk": "walk", "animal/walk": "walk", "animal": "walk", "actor": "walk",
    "crawl": "walk", "hop": "walk", "climb": "walk",
    "plant": "plant", "tree": "plant", "pflanze": "plant",
    "thing": "thing", "furniture": "thing", "object": "thing", "ding": "thing",
    "building": "building", "house": "building",
    "vehicle": "vehicle", "fahrzeug": "vehicle",
    "light": "light", "lamp": "light", "licht": "light", "magic": "magic", "zauber": "magic",
    "weather": "weather", "cloud": "weather", "rain": "weather",
}


def _words(name):
    return re.findall(r"[a-zäöüß]+", (name or "").lower())


def _has(words, text, word):
    return word in words or (len(word) >= 5 and word in text)


def family_for(name="", kind="", move=""):
    """The recipe family for a thing. Deterministic and dependency-free (tests import this)."""
    words = _words(name)
    text = " ".join(words)
    kind_key = (kind or "").strip().lower()
    for family in ("weather", "light", "vehicle", "building", "fly", "swim", "plant", "thing", "person", "magic"):
        if any(_has(words, text, w) for w in WORDS[family]):
            return family
    move_key = (move or "").strip().lower()
    if move_key in ("fly", "swim"):
        return move_key
    if move_key in ("walk", "hop", "crawl", "climb"):
        return "walk"
    if kind_key in KIND_FAMILY:
        return KIND_FAMILY[kind_key]
    return "walk" if kind_key in ("actor", "animal") else "thing"


def preset_for(name="", family=None):
    """A growl for a dragon-ish magic thing; the sparkle for other magic."""
    if family != "magic":
        return family
    words = _words(name)
    text = " ".join(words)
    return "growl" if any(_has(words, text, w) for w in GROWL) else "sparkle"


def seed_of(text):
    return int.from_bytes(hashlib.sha256(str(text or "thing").encode("utf-8")).digest()[:4], "big")


def _shape(x, r, dsp, length):
    """Pad or trim to length, fade the ends, then peak-normalise to -3 dBFS."""
    n = dsp.n_of(length)
    if len(x) > n:
        x = x[:n]
    elif len(x) < n:
        x = dsp.stack([(x, 0, 0)], length=length)
    x = dsp.fade(x, fin=0.002, fout=0.035)
    return dsp.normalize(x, -3.0)


def recipe(family, preset, r, dsp):
    """One short mono float array (48 kHz) for a family, built only from earshot.forge.dsp."""
    length = LENGTHS.get(family, 0.5)
    air = lambda sec, center, flutter=0.6, gain=0.35: (gain * dsp.air(sec, r, center=center, flutter=flutter), 0, 0)
    if family == "person":
        voice = dsp.fm(205, 2.0, 1.35, 0.30, decay=1.7, index_decay=0.7)
        tail = dsp.fm(310, 3.0, 0.55, 0.16, decay=3.0)
        x = dsp.stack([(voice, 0, 0), (tail, 0.14, 0), air(0.4, 900, 0.3, 0.08)], length=length)
    elif family == "fly":
        chirp = lambda at, f: (dsp.fm(f, 2.0, 1.4, 0.10, decay=3.2), at, 0)
        x = dsp.stack([air(length, 2200, 0.9, 0.5), chirp(0.05, 1500), chirp(0.24, 1950),
                       (0.25 * dsp.bell(2600, 0.25, r, "bar", decay=0.7, bright=0.4), 0.12, 0)], length=length)
    elif family == "swim":
        bubble = lambda at, f: (dsp.sub_drop(0.18, r, f0=f, f1=f * 0.35, drop=0.6, decay=0.55, harm=0.1, click=0.04), at, 0)
        x = dsp.stack([air(length, 500, 0.35, 0.18), bubble(0.02, 820), bubble(0.15, 1150), bubble(0.29, 640)],
                      length=length)
    elif family == "walk":
        step = lambda at, f, g: (dsp.mic(dsp.excite(
            dsp.modal([f, f * 1.8, f * 2.7], [0.06, 0.04, 0.02], [1, 0.55, 0.25], 0.2, r),
            dsp.contact(0.002, r)), r), at, g)
        x = dsp.stack([step(0.02, 120, 0.9), step(0.27, 150, 0.7), air(0.5, 1200, 0.4, 0.12)], length=length)
    elif family == "plant":
        tick = lambda at: (dsp.modal([2400, 3700], [0.02, 0.012], [1, 0.4], 0.08, r), at, 0.35)
        x = dsp.stack([air(length, 3200, 0.85, 0.8), tick(0.09), tick(0.28), tick(0.46)], length=length)
    elif family == "thing":
        hit = dsp.excite(dsp.modal([430, 780, 1320], [0.09, 0.055, 0.03], [1, 0.5, 0.25], 0.28, r),
                         dsp.contact(0.0015, r))
        x = dsp.stack([(dsp.mic(hit, r), 0, 0), air(0.3, 900, 0.2, 0.06)], length=length)
    elif family == "building":
        creak = dsp.fm(62, 1.3, 2.2, 0.55, decay=1.7, index_decay=0.9)
        knock = dsp.excite(dsp.modal([90, 150], [0.08, 0.05], [1, 0.5], 0.28, r), dsp.contact(0.002, r))
        x = dsp.stack([(creak, 0, 0), (0.6 * knock, 0.05, 0), air(length, 500, 0.4, 0.3)], length=length)
    elif family == "vehicle":
        motor = dsp.fm(88, 1.5, 2.0, 0.68, decay=0.55, index_decay=0.55)
        x = dsp.stack([(motor, 0, 0), air(length, 600, 0.5, 0.3)], length=length)
    elif family == "light":
        x = dsp.stack([(dsp.bell(1320, 0.62, r, "bar", decay=0.55, bright=0.45), 0, 0),
                       (0.45 * dsp.bell(1980, 0.5, r, "bar", decay=0.7, bright=0.5), 0.02, 0)], length=length)
    elif family == "magic" and preset == "growl":
        growl = dsp.fm(64, 1.4, 3.0, 0.6, decay=1.5, index_decay=1.1)
        x = dsp.stack([(growl, 0, 0), air(length, 300, 0.7, 0.4)], length=length)
    elif family == "weather":
        gust = 0.9 * dsp.air(length, r, center=900, flutter=0.9)
        x = dsp.stack([(gust, 0, 0), (0.22 * dsp.noise(length, r, "pink"), 0, 0)], length=length)
    else:                                    # magic: sparkle
        notes = [(dsp.bell(1560, 0.42, r, "bar", decay=0.65, bright=0.5), 0, 0),
                 (0.75 * dsp.bell(2340, 0.36, r, "bar", decay=0.65, bright=0.5), 0.07, 0),
                 (0.55 * dsp.bell(3120, 0.30, r, "bar", decay=0.7, bright=0.5), 0.14, 0)]
        x = dsp.stack(notes + [air(length, 4200, 0.5, 0.18)], length=length)
    # a small room and a microphone, then a clean -3 dBFS mono file
    x = dsp.room(x, r, rt60=0.2, size=0.4, wet=0.08)
    x = dsp.mic(x, r)
    return _shape(x, r, dsp, length)


def venv_python():
    return os.path.join(VENV_DIR, "bin", "python")


def _in_venv():
    # sys.executable is a symlink to the system python inside a venv; sys.prefix is the venv itself
    return os.path.realpath(sys.prefix) == os.path.realpath(VENV_DIR)


def _run(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def ensure_setup():
    """Clone the pinned earshot checkout and create the DSP venv once. Network only here."""
    git = os.environ.get("KRITZEL_GIT", "git")
    if not os.path.isdir(os.path.join(EARSHOT_DIR, ".git")):
        os.makedirs(os.path.dirname(EARSHOT_DIR), exist_ok=True)
        _run([git, "clone", "-q", EARSHOT_REPO, EARSHOT_DIR])
    try:
        head = subprocess.run([git, "-C", EARSHOT_DIR, "rev-parse", "HEAD"], check=True,
                              capture_output=True, text=True).stdout.strip()
        if head != EARSHOT_COMMIT:
            _run([git, "-C", EARSHOT_DIR, "fetch", "-q", "origin"])
            _run([git, "-C", EARSHOT_DIR, "checkout", "-q", EARSHOT_COMMIT])
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"could not pin earshot at {EARSHOT_COMMIT[:8]}: {e}") from e
    if not os.path.exists(venv_python()):
        _run([sys.executable, "-m", "venv", VENV_DIR])
    probe = subprocess.run([venv_python(), "-c", "import numpy, scipy, soundfile"], capture_output=True)
    if probe.returncode != 0:
        _run([venv_python(), "-m", "pip", "install", "-q", "--disable-pip-version-check", *PINS])


def render(name, kind, move, seed, out, family=None):
    if not os.path.isdir(EARSHOT_DIR):
        raise RuntimeError(f"earshot is not set up at {EARSHOT_DIR}: run scripts/thing_sounds.py --ensure")
    family = family or family_for(name, kind, move)
    preset = preset_for(name, family)
    sys.path.insert(0, EARSHOT_DIR)
    try:
        import numpy as np
        import soundfile as sf
        from earshot.forge import dsp
    except Exception as e:                  # no venv dependencies: say exactly what is missing
        raise RuntimeError(f"earshot DSP imports failed ({e}): run scripts/thing_sounds.py --ensure") from e
    t0 = time.time()
    x = recipe(family, preset, dsp.rng(seed_of(seed)), dsp)
    x = np.asarray(x, dtype="float32")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    wav = out + ".tmp.wav"
    tmp = out + ".tmp.ogg"
    sf.write(wav, x, dsp.SR, subtype="FLOAT")
    ffmpeg = os.environ.get("KRITZEL_FFMPEG", "ffmpeg")
    try:
        _run([ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-ar", str(dsp.SR),
              "-c:a", "libvorbis", "-q:a", "4", "-map_metadata", "-1",
              "-fflags", "+bitexact", "-flags:a", "+bitexact", tmp], stdout=subprocess.DEVNULL,
             stderr=subprocess.PIPE, text=True)
        os.replace(tmp, out)
    finally:
        for p in (wav, tmp):
            try:
                os.remove(p)
            except FileNotFoundError:
                pass
    seconds = round(time.time() - t0, 2)
    size = os.path.getsize(out)
    return {"family": family, "preset": preset, "seconds": seconds, "bytes": size,
            "duration": round(len(x) / dsp.SR, 2), "file": out}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Render a short earshot DSP sound for a drawn thing.")
    ap.add_argument("--name", default="", help="meta.name of the thing")
    ap.add_argument("--kind", default="", help="actor, or a family hint (lamp, building, ...)")
    ap.add_argument("--move", default="", help="the actor's move: fly, swim, hop, crawl, climb, walk")
    ap.add_argument("--seed", default=None, help="stable seed text (default: the name)")
    ap.add_argument("--out", default=None, help="output .ogg")
    ap.add_argument("--family", default=None, choices=FAMILIES, help="force a family (tests/measurement)")
    ap.add_argument("--ensure", action="store_true", help="clone earshot and create its venv once")
    ap.add_argument("--list-families", action="store_true")
    args = ap.parse_args(argv)
    try:
        if args.ensure:
            ensure_setup()
        if args.list_families:
            print("\n".join(FAMILIES))
            return 0
        if not args.out:
            if args.ensure:
                print(json.dumps({"ensured": True, "earshot": EARSHOT_DIR, "venv": VENV_DIR}))
                return 0
            ap.error("--out is required")
        if not _in_venv():
            py = venv_python()
            if not os.path.exists(py):
                raise RuntimeError(f"the earshot venv is missing at {VENV_DIR}: run scripts/thing_sounds.py --ensure")
            # re-run this file under the venv; drop --ensure so it is not repeated
            rest = [a for a in (argv if argv is not None else sys.argv[1:]) if a != "--ensure"]
            os.execv(py, [py, os.path.abspath(__file__), *rest])
        info = render(args.name, args.kind, args.move, args.seed or args.name, args.out, args.family)
        print(json.dumps(info))
        return 0
    except Exception as e:
        print(f"thing sound: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
