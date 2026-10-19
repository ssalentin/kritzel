// The viewer's per-thing sound path, without a browser: a fake AudioContext records what starts.
// A thing with an Ogg plays it on arrival and tap; a thing without one keeps the generic role;
// before the first click (setEnabled) nothing starts and nothing is fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSound } from './sound.js';

const started = [];
let fetches = [];
let hasStein = false;
class Param {
  constructor() { this.value = 0; }
  setValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
}
class Node {
  constructor() { this.gain = new Param(); this.frequency = new Param(); this.Q = new Param(); this.pan = new Param(); this.playbackRate = new Param(); }
  connect(n) { return n; }
  start() { started.push(this); }
  stop() {}
}
class Ctx {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = new Node(); }
  createGain() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { const n = new Node(); n.buffer = null; n.loop = false; return n; }
  createBiquadFilter() { return new Node(); }
  createOscillator() { return new Node(); }
  createStereoPanner() { return new Node(); }
  decodeAudioData() { return Promise.resolve({ decoded: true }); }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
}

globalThis.window = { AudioContext: Ctx };
globalThis.fetch = async url => {
  const u = String(url);
  fetches.push(u);
  if (u.endsWith('/sounds/things/drache.ogg')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  if (u.endsWith('/sounds/things/stein.ogg') && hasStein) return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
  return { ok: false, status: 404 };
};

const box = file => ({ userData: { thingFile: file }, parent: null });
const settle = () => new Promise(ok => setTimeout(ok, 5));

test('nothing plays or is fetched before the first click', async () => {
  fetches = [];
  const s = createSound({ Vector3: class { constructor() { this.x = 0; this.y = 0; this.z = 0; } } }, {});
  s.prepareThing('drache.js');
  s.fx('arrival', box('drache.js'));
  await settle();
  assert.deepEqual(fetches, []);
  assert.equal(s.lastPlay(), null);
  assert.equal(started.length, 0);
});

test('a thing with an Ogg plays it on arrival and tap; one without keeps the generic role', async () => {
  started.length = 0;
  const s = createSound({ Vector3: class { constructor() { this.x = 0; this.y = 0; this.z = 0; } } }, {});
  await s.setEnabled(true);
  await settle();
  const before = started.length;                  // the wind bed
  await s.prepareThing('drache.js');
  assert.ok(s.thingSound('drache').buf, 'the dragon sound did not decode');
  s.fx('arrival', box('drache.js'));
  assert.equal(started.length, before + 1);
  const arrival = s.lastPlay();
  assert.equal(arrival.role, 'thing');
  assert.equal(arrival.file, 'drache');
  assert.equal(arrival.targetRole, 'arrival');
  assert.ok(arrival.rate >= 0.95 && arrival.rate <= 1.05, String(arrival.rate));
  s.fx('tap', box('drache.js'));
  assert.equal(s.lastPlay().targetRole, 'tap');

  // index.html taps a character with who.rig.g; the rig's parent (entry.free) carries the file
  const rig = { userData: {}, parent: { userData: { thingFile: 'drache.js' }, parent: null } };
  s.fx('tap', rig);
  assert.equal(s.lastPlay().role, 'thing');
  assert.equal(s.lastPlay().file, 'drache');

  await s.prepareThing('stein.js');               // 404: cached as missing
  assert.equal(s.thingSound('stein').missing, true);
  s.fx('arrival', box('stein.js'));
  const generic = s.lastPlay();
  assert.equal(generic.role, 'arrival');
  assert.equal(generic.generic, true);

  // a rewrite invalidates the cache: a new Ogg is fetched, and a cached 404 can become a sound
  const fetchedBefore = fetches.filter(u => u.endsWith('/sounds/things/drache.ogg')).length;
  const old = s.thingSound('drache').buf;
  await s.prepareThing('drache.js');
  assert.equal(fetches.filter(u => u.endsWith('/sounds/things/drache.ogg')).length, fetchedBefore);
  s.forgetThing('drache.js');
  await s.prepareThing('drache.js');
  assert.equal(fetches.filter(u => u.endsWith('/sounds/things/drache.ogg')).length, fetchedBefore + 1);
  assert.notEqual(s.thingSound('drache').buf, old);
  hasStein = true;
  s.forgetThing('stein.js');
  await s.prepareThing('stein.js');
  assert.ok(s.thingSound('stein').buf, 'a 404 that later becomes an Ogg must load after forgetThing');
  hasStein = false;
});
