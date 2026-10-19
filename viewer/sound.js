// Sound for the paper world (Web Audio API). A small Ogg bank rendered from earshot
// (scripts/make-sounds.sh) gives the nine named roles; the procedural effects below stay as
// fallback and for the babble/word layer, so a missing or not-yet-decoded bank never goes silent.
// Off until the user presses the button (browsers only allow audio after a gesture).
//  - every speech bubble babbles softly, Animal-Crossing style, with a pitch per speaker
//  - some words trigger little effects (Quak, Piep, Buh, Mampf, Juhu …)
//  - a very quiet wind bed in the background
//  - sounds are panned/attenuated by where the speaker is relative to the camera
// Two ways to use it (both reach the same single instance):
//  - engine/things: createSound(THREE, camera) → .speak(obj, text), .fx(name, obj), .setEnabled(on)
//  - sim: import { sound } from './sound.js'; sound.at(obj).mampf()   (plop, tune, buh, chirp, …)
// Roles: arrival, pageTurn, tap, giggle, sparkle, rain, thunder, newWorld, typedArrival.
// a voice of the page's language (de/en from <html lang>), found once the browser has loaded its voices
const voices = {};
// The bank: decoded once after the first click, then reused. Each role gets a measured gain
// (earshot measure, balanced to about -26 LUFS momentary before the master gain) and a small
// random playback rate so repeats do not sound identical.
const BANK = {
  arrival: 'arrival.ogg',
  pageTurn: 'page-turn.ogg',
  tap: 'tap.ogg',
  giggle: 'giggle.ogg',
  sparkle: 'sparkle.ogg',
  rain: 'rain.ogg',
  thunder: 'thunder.ogg',
  newWorld: 'new-world.ogg',
  typedArrival: 'typed-arrival.ogg',
};
const BANK_GAIN = {
  arrival: 0.63, pageTurn: 0.58, tap: 0.9, giggle: 0.71, sparkle: 0.81,
  rain: 0.36, thunder: 0.69, newWorld: 0.53, typedArrival: 0.29,
};
// before the bank is ready every role still has the procedural sound it replaces
const BANK_FALLBACK = {
  arrival: 'plopp', pageTurn: 'rascheln', tap: 'plopp', giggle: 'melodie', sparkle: 'staunen',
  rain: 'rascheln', thunder: 'buh', newWorld: 'melodie', typedArrival: 'piep',
};
function voiceFor(lang) {
  const ss = globalThis.speechSynthesis;
  if (!ss) return null;
  if (!(lang in voices)) {
    const all = ss.getVoices();
    if (!all.length) return null;                       // not loaded yet: babble this time, try again next bubble
    const same = all.filter(v => v.lang?.toLowerCase().startsWith(lang));
    voices[lang] = same.find(v => /natural|neural|premium|enhanced/i.test(v.name)) || same.find(v => v.localService) || same[0] || null;
  }
  return voices[lang];
}
// reads a bubble aloud; false when no voice is there (then the babble plays). At most one line waits behind
// the one being spoken, so a chatty moment never piles up a minute of speech.
function readAloud(text, baseHz) {
  const ss = globalThis.speechSynthesis, lang = (document.documentElement.lang || 'de').slice(0, 2).toLowerCase();
  const voice = voiceFor(lang);
  if (!ss || !voice) return false;
  if (ss.pending) return true;                          // one waiting already: this line is shown, not spoken
  const u = new SpeechSynthesisUtterance(text.replace(/[\p{Extended_Pictographic}♥…]/gu, ' ').replace(/\s+/g, ' ').trim());
  if (!u.text) return true;
  u.voice = voice; u.lang = voice.lang; u.rate = 0.95;
  u.pitch = Math.max(0.6, Math.min(1.6, 0.6 + (baseHz - 200) / 300));   // the babble's pitch, as a voice pitch
  ss.speak(u);
  return true;
}

export function createSound(THREE, camera) {
  let ctx = null, master = null, wind = null, enabled = false;
  const bank = {};                             // role → decoded AudioBuffer
  let last = null;                             // the last bank role played (tests/debug)
  const v = new THREE.Vector3();

  function loadBank() {
    for (const [role, file] of Object.entries(BANK)) {
      fetch(new URL('./sounds/' + file, import.meta.url))
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))
        .then(b => ctx.decodeAudioData(b))
        .then(buf => { bank[role] = buf; })
        .catch(() => {});                      // a missing file keeps the procedural fallback
    }
  }

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    // wind: looping filtered noise with a slow swell
    const len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = last * 0.98 + (Math.random() * 2 - 1) * 0.02; d[i] = last * 4; }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    wind = ctx.createGain(); wind.gain.value = 0.05;
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07; lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain).connect(wind.gain);
    src.connect(lp).connect(wind).connect(master);
    src.start(); lfo.start();
    loadBank();
  }

  // stereo pan + distance attenuation for a sound coming from an object
  function spot(obj) {
    const pan = ctx.createStereoPanner(), g = ctx.createGain();
    if (obj?.getWorldPosition) {
      obj.getWorldPosition(v);
      const dist = v.distanceTo(camera.position);
      v.applyMatrix4(camera.matrixWorldInverse);
      pan.pan.value = Math.max(-0.9, Math.min(0.9, v.x / Math.max(4, -v.z || 4)));
      g.gain.value = Math.max(0.12, Math.min(1, 14 / Math.max(1, dist)));
    }
    g.connect(pan).connect(master);
    return g;
  }

  const env = (node, t0, a, peak, dur) => {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(peak, t0 + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  };
  function tone(out, t0, freq, dur, { type = 'triangle', peak = 0.18, slide = 0 } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * slide), t0 + dur);
    env(g, t0, 0.012, peak, dur);
    o.connect(g).connect(out); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(out, t0, dur, freq, peak = 0.2) {
    const len = Math.ceil(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(); s.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.2;
    const g = ctx.createGain(); env(g, t0, 0.01, peak, dur);
    s.connect(bp).connect(g).connect(out); s.start(t0);
  }
  // one bank role, spatialised like the procedural effects: source → role gain → spot → master
  function playBank(role, obj) {
    const buf = bank[role];
    if (!buf) return false;
    const src = ctx.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = role === 'giggle'
      ? 1.08 + Math.random() * 0.12                 // a child's giggle sits a little higher each time
      : 1 + (Math.random() * 2 - 1) * 0.05;
    const g = ctx.createGain();
    g.gain.value = (BANK_GAIN[role] ?? 0.5) * (0.92 + Math.random() * 0.16);
    last = { role, rate: src.playbackRate.value, gain: g.gain.value };
    src.connect(g).connect(spot(obj));
    src.start(ctx.currentTime + 0.005);
    return true;
  }

  // pitch per speaker, stable across reloads (hash of the speaker's uuid/name)
  const pitchOf = key => { let h = 0; for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 200 + (h % 340); };

  const FX = {
    plopp: (o, t) => tone(o, t, 520, 0.12, { type: 'sine', peak: 0.3, slide: 0.45 }),
    melodie: (o, t) => [523, 659, 784, 1047].forEach((f, i) => tone(o, t + i * 0.13, f, 0.16, { type: 'sine', peak: 0.16 })),
    buh: (o, t) => { tone(o, t, 140, 0.45, { type: 'sawtooth', peak: 0.12, slide: 0.6 }); tone(o, t, 147, 0.45, { type: 'sine', peak: 0.15, slide: 0.6 }); },
    mampf: (o, t) => { noise(o, t, 0.08, 900, 0.25); noise(o, t + 0.16, 0.08, 800, 0.22); },
    piep: (o, t) => [0, 0.11, 0.22].forEach(d => tone(o, t + d, 2400 + Math.random() * 600, 0.07, { type: 'sine', peak: 0.1, slide: 1.4 })),
    quak: (o, t) => { tone(o, t, 330, 0.16, { type: 'square', peak: 0.07, slide: 0.7 }); tone(o, t + 0.2, 300, 0.18, { type: 'square', peak: 0.07, slide: 0.65 }); },
    staunen: (o, t) => tone(o, t, 300, 0.5, { type: 'sine', peak: 0.16, slide: 1.8 }),
    rascheln: (o, t) => noise(o, t, 0.35, 3000, 0.08),
    herz: (o, t) => { tone(o, t, 880, 0.12, { type: 'sine', peak: 0.12 }); tone(o, t + 0.12, 1320, 0.2, { type: 'sine', peak: 0.12 }); },
  };
  // other names used elsewhere map onto the same effects
  const ALIAS = { plop: 'plopp', tune: 'melodie', chirp: 'piep', babble: null };
  // words in a speech bubble that also trigger an effect
  const WORDS = [
    [/quak|quack/i, 'quak'], [/piep|tschilp|zwitscher|tirili|tweet|chirp/i, 'piep'], [/\bbuh\b|\bboo\b/i, 'buh'], [/mampf|lecker|mmh|yum|delicious/i, 'mampf'],
    [/^o+h*!*$|ooo/i, 'staunen'], [/juhu|juchhe|party|tanz|yay|woohoo|danc/i, 'melodie'], [/fünf|five/i, 'plopp'], [/♥/, 'herz'], [/rasch|wurzel|rustl/i, 'rascheln'],
  ];

  const api = {
    get enabled() { return enabled; },
    get ctxState() { return ctx?.state ?? 'off'; },
    async setEnabled(on) {
      enabled = on;
      if (on && !ctx) init();
      if (ctx) { if (on) await ctx.resume(); else await ctx.suspend(); }
    },
    fx(name, obj) {
      if (name in ALIAS) name = ALIAS[name];
      if (!enabled || !ctx) return;
      if (name in BANK && playBank(name, obj)) return;
      if (BANK_FALLBACK[name]) name = BANK_FALLBACK[name];
      if (!FX[name]) return;
      FX[name](spot(obj), ctx.currentTime + 0.01);
    },
    bankLoaded: () => Object.keys(bank),        // tests: which roles are decoded
    lastPlay: () => last,                       // tests: role, playback rate and gain of the last bank sound
    // called for every new speech bubble: the browser reads it aloud in the page's language (a seven-year-old
    // reads slowly), each figure with its own pitch; without a voice for the language, the soft babble as before
    speak(obj, text) {
      if (!enabled || !ctx || !text) return;
      const out = spot(obj), t0 = ctx.currentTime + 0.01, base = pitchOf(obj?.uuid);
      if (readAloud(text, base)) return;
      const n = Math.max(2, Math.min(7, Math.round(text.replace(/[^\p{L}]/gu, '').length / 3)));
      for (let i = 0; i < n; i++) {
        const f = base * (1 + (Math.random() - 0.4) * 0.35) * (text.endsWith('?') && i === n - 1 ? 1.3 : 1);
        tone(out, t0 + i * 0.085, f, 0.075, { type: 'triangle', peak: 0.13 });
      }
      for (const [re, name] of WORDS) if (re.test(text)) { FX[name](out, t0 + n * 0.085 + 0.05); break; }
    },
  };
  globalThis.__paperSound = api;     // one instance, shared with the `sound` export below
  return api;
}

// sim-style access: sound.at(obj).mampf() — works no matter which copy of this module was imported
export const sound = {
  get on() { return !!globalThis.__paperSound?.enabled; },
  at(obj) {
    return new Proxy({}, { get: (_, name) => () => globalThis.__paperSound?.fx(String(name), obj) });
  },
};
