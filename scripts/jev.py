"""Ask Jev (TypeSafe) what changed between the sheet before and the sheet after.

One Decisions request over OpenRouter, two frames and seven questions: six Nouls (new drawing,
addition, coloured in, crossed out, relabel, unchanged) and one Box around the new drawing.
`ask` never raises: a timeout, a non-200, a malformed reply or a missing key all return None, so
capture can carry on exactly as before.

KRITZEL_JEV=0 turns it off; the key comes from OPENROUTER_API_KEY (never logged).
"""
import base64
import json
import os
import subprocess
import time
import urllib.request

URL = "https://openrouter.ai/api/alpha/decisions"
MODEL = "typesafe/jev-1.14"
TIMEOUT = 2.0                    # s: the whole request may take this long, then we give up on it
SIDE = 1280                      # the API rejects a 1920×1080 frame; both are shrunk to this long side
CONFIDENT_UNCHANGED, CONFIDENT_KIND = 0.6, 0.4   # unchanged ≥ this and every kind < this: nothing changed
KINDS = (("new_drawing", "new"), ("addition", "addition"), ("coloured_in", "coloured_in"),
         ("crossed_out", "crossed_out"), ("relabel", "relabel"))
CONTEXT = ("The first image is a sheet of paper before. The second image is the same sheet after "
           "a child drew on it or moved something on it.")
QUESTIONS = {
    "new_drawing": {"type": "noul",
                    "instructions": "The after image has a new drawing that is not in the before image."},
    "addition": {"type": "noul",
                 "instructions": "The after image adds something to a drawing that is already in the before image."},
    "coloured_in": {"type": "noul",
                    "instructions": "The after image colours in a drawing that was already there, without drawing anything new."},
    "crossed_out": {"type": "noul",
                    "instructions": "The after image crosses out or scribbles over something that is in the before image."},
    "relabel": {"type": "noul",
                "instructions": "The after image changes or adds writing (a label or name) on the paper."},
    "unchanged": {"type": "noul",
                  "instructions": "Nothing meaningful changed between the before and the after image."},
    "box": {"type": "box",
            "instructions": "the new or changed drawing in the after image"},
}


def on(env=os.environ):
    """Whether change labels are wanted (default on)."""
    return (env.get("KRITZEL_JEV") or "1").strip().lower() not in ("0", "false", "no", "off")


def api_key(env=os.environ):
    return (env.get("OPENROUTER_API_KEY") or "").strip() or None


def shrink(jpeg, side=SIDE):
    """A frame small enough for the API (ffmpeg); the box's fractions still fit the full frame."""
    try:
        out = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "jpeg_pipe", "-i", "-", "-vf",
                              f"scale='min({side},iw)':-2", "-frames:v", "1", "-f", "image2",
                              "-c:v", "mjpeg", "-q:v", "3", "-"],
                             input=jpeg, capture_output=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return jpeg
    return out or jpeg


def request(before, after):
    """The Decisions body: both JPEGs as data URIs in the state, as the measurements used."""
    image = lambda jpeg: {"type": "image_url",
                          "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}}
    return {"model": MODEL, "state": [CONTEXT, image(before), image(after)], "questions": QUESTIONS}


def _post(body, timeout, key):
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "TypeSafe-Danger-Zone-Images": "true",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def box_px(box, size):
    """Jev's box (fractions of the picture) as [x, y, w, h] in picture px, or None."""
    try:
        left, top, right, bottom = (float(box[k]) for k in ("left", "top", "right", "bottom"))
    except (KeyError, TypeError, ValueError):
        return None
    w, h = size
    x0, x1 = min(max(round(left * w), 0), w), min(max(round(right * w), 0), w)
    y0, y1 = min(max(round(top * h), 0), h), min(max(round(bottom * h), 0), h)
    return [x0, y0, x1 - x0, y1 - y0] if x1 > x0 and y1 > y0 else None


def read(out, size=None):
    """Jev's reply as {changed, kind, box, confidence, seconds}, or None if it is not usable.

    changed: probability that something changed; 0.0 when it confidently says nothing did.
    kind: the likeliest of the five kinds, or "unchanged" if that outweighs them.
    box: Jev's box, in picture px when `size` is given, else its {left, top, right, bottom} fractions.
    confidence: the Box's own confidence (0.0 when there is no box)."""
    try:
        answers = out["answers"]
        unchanged = float(answers["unchanged"]["noul"])
        probs = {key: float(answers[key]["noul"]) for key, _ in KINDS}
        for key, _ in KINDS:
            if answers[key]["type"] != "noul":
                return None
    except (KeyError, TypeError, ValueError):
        return None
    key, best = max(probs.items(), key=lambda kv: kv[1])
    kind, confidence = (key, best) if best > unchanged else ("unchanged", unchanged)
    changed = round(max(0.0, min(1.0, 1.0 - unchanged)), 3)
    if unchanged >= CONFIDENT_UNCHANGED and best < CONFIDENT_KIND:
        changed = 0.0                # confident, and no kind is anywhere near it: nothing changed
    box = answers.get("box")
    box = box if isinstance(box, dict) and box.get("type") == "box" else {}
    return {"changed": changed, "kind": dict(KINDS).get(kind, kind),
            "box": box_px(box.get("box"), size) if size else box.get("box"),
            "confidence": round(float(box.get("confidence") or 0.0), 3)}


def ask(before, after, size=None, key=None, timeout=TIMEOUT, post=None, scale=None):
    """The label for one settled change, or None.

    `post` is the HTTP layer and `scale` the frame shrinker; tests hand in fakes for both."""
    key = api_key() if key is None else key
    if not key:
        return None
    started = time.monotonic()
    try:
        scale = scale or shrink
        out = (post or _post)(json.dumps(request(scale(before), scale(after))).encode(), timeout, key)
        label = read(out, size)
    except Exception:
        return None
    if label:
        label["seconds"] = round(time.monotonic() - started, 3)
    return label
