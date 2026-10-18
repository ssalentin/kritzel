// Short dialogues between two characters who meet (issue #9): 3-5 turns that answer each other, about
// what is in the world right now, shaped by how the two get along, ending in something they do.
// Every turn has a German and an English twin. {a} / {b} are the speakers' names, {thing} the newest
// drawing, {prisoner} who is in the jail, {item} what someone holds. A generated pool
// can add more of the same shape (things/dialogues.json); these templates are the base that is always there.
//
// when(c) decides if a template fits: c = { a, b, r (relationship 0..1), night, cloudy, lamp, newest,
// jail, held, memo } (see context() in sim-extra.js). end: what the two do afterwards.
export const DIALOGUES = [
  { w: 3, when: c => c.newest, end: 'look', turns: [
    ['a', 'Hast du das Neue gesehen? Da drüben: {thing}!', 'Have you seen the new thing? Over there: {thing}!'],
    ['b', 'Nein! Was ist das denn?', 'No! What is it?'],
    ['a', 'Ganz neu im Buch. Komm, wir schauen!', 'It just arrived. Let\'s go look!'] ] },
  { w: 2, when: c => c.newest && c.r > 0.5, end: 'look', turns: [
    ['a', '{b}, da drüben ist was Neues!', '{b}, there\'s something new over there!'],
    ['b', 'Echt? Ist es nett?', 'Really? Is it nice?'],
    ['a', 'Finden wir es raus!', 'Let\'s find out!'],
    ['b', 'Aber du gehst vor.', 'You go first, though.'] ] },
  { w: 1, when: c => c.jail && ![c.a, c.b].some(x => (x.name || x.id) === c.jail.prisoner), end: 'look', turns: [
    ['a', 'Warum ist {prisoner} im Gefängnis?', 'Why is {prisoner} in the jail?'],
    ['b', 'Jemand hat ein Gefängnis drumherum gemalt!', 'Someone drew a jail around it!'],
    ['a', 'Armes Ding. Wir besuchen es.', 'Poor thing. Let\'s visit.'] ] },
  { w: 3, when: c => c.held && c.held.holder === c.a.name, end: 'stroll', turns: [
    ['a', 'Schau mal, {b}, was ich hier habe!', 'Look what I have here, {b}!'],
    ['b', 'Wow! Was kann das?', 'Wow! What does it do?'],
    ['a', 'Komm mit, ich zeig es dir!', 'Come along, I\'ll show you!'] ] },
  { w: 3, when: c => c.night, end: 'stroll', turns: [
    ['a', 'Es ist so dunkel geworden.', 'It got so dark.'],
    ['b', 'Ein bisschen gruselig, oder?', 'A little spooky, right?'],
    ['a', 'Wir bleiben einfach zusammen, {b}.', 'We\'ll just stay together, {b}.'],
    ['b', 'Gute Idee.', 'Good idea.'] ] },
  { w: 3, when: c => c.night && c.lamp, end: 'stroll', turns: [
    ['a', 'Schau, da leuchtet was!', 'Look, something\'s glowing!'],
    ['b', 'Wie schön warm das aussieht.', 'It looks so warm.'],
    ['a', 'Komm, wir gehen zum Licht.', 'Come on, let\'s go to the light.'] ] },
  { w: 2, when: c => c.cloudy, end: 'dance', turns: [
    ['a', 'Die Wolke ist so groß!', 'That cloud is so big!'],
    ['b', 'Vielleicht regnet es gleich.', 'Maybe it will rain.'],
    ['a', 'Dann tanzen wir im Regen!', 'Then we dance in the rain!'] ] },
  { w: 2, when: c => c.r > 0.6, end: 'dance', turns: [
    ['a', '{b}! Hörst du die Musik?', '{b}! Can you hear the music?'],
    ['b', 'Welche Musik?', 'What music?'],
    ['a', 'Na, die in meinem Kopf! Tanz mit mir!', 'The one in my head! Dance with me!'] ] },
  { w: 2, when: c => c.r > 0.5, end: 'tag', turns: [
    ['a', 'Wetten, du kriegst mich nicht?', 'Bet you can\'t catch me!'],
    ['b', 'Wetten doch!', 'Bet I can!'],
    ['a', 'Dann fang mich, {b}!', 'Then catch me, {b}!'] ] },
  { w: 2, when: c => c.r > 0.4, end: 'stroll', turns: [
    ['a', 'Was machen wir heute, {b}?', 'What shall we do today, {b}?'],
    ['b', 'Ein Stück spazieren?', 'Go for a little walk?'],
    ['a', 'Au ja, los!', 'Oh yes, let\'s go!'] ] },
  { w: 3, when: c => c.r < 0.3, end: null, turns: [
    ['a', 'Ähm… hallo.', 'Um… hello.'],
    ['b', 'Hallo. Ich bin {b}.', 'Hello. I\'m {b}.'],
    ['a', 'Ich bin {a}. Schön hier, oder?', 'I\'m {a}. Nice here, isn\'t it?'],
    ['b', 'Ja, sehr schön.', 'Yes, very nice.'] ] },
  { w: 3, when: c => c.a.fear > 0.3, end: 'stroll', turns: [
    ['a', 'Ich hab mich so erschreckt…', 'I got such a fright…'],
    ['b', 'Oh nein! Was ist passiert, {a}?', 'Oh no! What happened, {a}?'],
    ['a', 'Ach, schon gut. Jetzt geht es wieder.', 'Oh, it\'s fine. I\'m better now.'],
    ['b', 'Ich bleib bei dir.', 'I\'ll stay with you.'] ] },
  { w: 4, when: c => c.memo === 'comfort', end: null, turns: [
    ['a', 'Weißt du noch, als du mich getröstet hast?', 'Remember when you comforted me?'],
    ['b', 'Klar weiß ich das, {a}!', 'Of course I do, {a}!'],
    ['a', 'Danke nochmal. Du bist echt lieb.', 'Thanks again. You\'re really kind.'] ] },
  { w: 4, when: c => c.memo === 'spook', end: 'tag', turns: [
    ['a', 'Weißt du noch, dein Buh?', 'Remember your boo?'],
    ['b', 'Hihi, du bist so hochgesprungen!', 'Hehe, you jumped so high!'],
    ['a', 'Mach das nie wieder, {b}!', 'Never do that again, {b}!'],
    ['b', 'Versprochen… vielleicht!', 'Promise… maybe!'] ] },
  { w: 1, when: () => true, end: 'stroll', turns: [
    ['a', 'Schöner Tag heute, oder?', 'Lovely day, isn\'t it?'],
    ['b', 'Ja! Das Buch ist so schön.', 'Yes! The book is so pretty.'],
    ['a', 'Komm, wir gehen ein Stück.', 'Come on, let\'s walk a bit.'] ] },
];

// a template or pool entry → { turns: [{ speaker, de, en }], end } with the slots filled in
export function fill(t, c) {
  const names = { a: c.a.name || c.a.id, b: c.b.name || c.b.id };
  const sub = s => s.replace(/\{a\}/g, names.a).replace(/\{b\}/g, names.b).replace(/\{thing\}/g, c.newest?.name || '')
    .replace(/\{prisoner\}/g, c.jail?.prisoner || '').replace(/\{item\}/g, c.held?.item || '');
  return { end: t.end || null, turns: t.turns.map(([who, de, en]) => ({ speaker: who === 'a' ? c.a : c.b, de: sub(de), en: sub(en) })) };
}

// pick one fitting template, weighted; R() is the sim's random source
const recent = [];                         // the last templates played: not again right away
export function pickDialogue(c, R) {
  const fits = DIALOGUES.filter(t => { try { return t.when(c); } catch { return false; } });
  const fit = fits.filter(t => !recent.includes(t)).length ? fits.filter(t => !recent.includes(t)) : fits;
  let x = R() * fit.reduce((s, t) => s + t.w, 0);
  let t = fit.at(-1);
  for (const f of fit) if ((x -= f.w) < 0) { t = f; break; }
  recent.push(t); if (recent.length > 3) recent.shift();
  return fill(t, c);
}

// ---------- child-safe filter: generated lines pass it before they are written and again before playback ----------
// one denylist per language: the English 'die' is the German article, so they must not share one
// whole words only (with their usual forms), never word beginnings: 'Waffel', 'Drogerie', 'Blutorange',
// 'shooting star' and 'drugstore' are fine. \p{L} boundaries, because \b knows no umlauts or ß.
const words = (list, extra = '') => new RegExp(`(?<!\\p{L})(?:${list.join('|')}${extra})(?!\\p{L})`, 'iu');
const BAD_DE = words(['tot', 'tote[nrs]?', 'totenkopf', 'töte[nt]?', 'getötet', 'sterben', 'stirbt', 'starb', 'gestorben', 'blut', 'blutig\\p{L}*', 'blutet',
  'waffen?', 'schießen', 'schießt', 'erschießen', 'erschossen', 'hass', 'hasse[nt]?', 'hasst', 'dumm', 'dumme[nrs]?', 'dummkopf', 'idiot(?:en)?',
  'blöd', 'blöde[nrs]?', 'blödmann', 'scheiß\\p{L}*', 'sex', 'drogen?', 'alkohol', 'bier', 'wein']);
const BAD_EN = words(['kill', 'kills', 'killed', 'killing', 'killer', 'dead', 'die', 'dies', 'died', 'dying', 'blood', 'bloody', 'guns?',
  'shoot', 'shoots', 'weapons?', 'hate', 'hates', 'hated', 'stupid', 'idiots?', 'shut up', 'sex', 'drugs?', 'alcohol', 'beer', 'wine'],
  '|shooting(?! stars?(?!\\p{L}))');
const clean = (s, bad) => typeof s === 'string' && s.length > 0 && s.length <= 90 && !bad.test(s) && !/[<>{}]|https?:/.test(s);
export function safeLine(s, lang = 'de') { return clean(s, lang === 'en' ? BAD_EN : BAD_DE); }
export function safeDialogue(d) {
  return d && Array.isArray(d.between) && d.between.length === 2 && Array.isArray(d.turns) && d.turns.length >= 2 && d.turns.length <= 6 &&
    d.turns.every(t => d.between.includes(t.who) && safeLine(t.de, 'de') && safeLine(t.en, 'en')) &&
    [null, 'stroll', 'dance', 'tag', 'look'].includes(d.end ?? null);
}

// ---------- the generated pool (things/dialogues.json next to placement.json, written by generate/dialogues.mjs) ----------
// { cast: [names], dialogues: [{ between: [nameA, nameB], end, turns: [{ who: name, de, en }] }] }
let pool = [], poolAt = 0, personas = {}, quests = [];
const played = new Set();                  // played dialogues, by content (the pool grows and is re-read: an index would shift)
const contentKey = d => JSON.stringify(d.turns);
// the figures' personalities (dialogues.json personas, keyed by actor id); refs are names or ids, resolved by the sim
export const HOBBIES = ['collect', 'guard', 'nap', 'follow', 'wander'];
// signature acts (GitHub #26): the repertoire the sim can show, agreed with generate/dialogues.mjs (ACTS there)
export const ACTS = ['spin', 'hop', 'bow', 'wave-big', 'roar', 'sing-notes', 'sparkle', 'sun-burst', 'splash', 'juggle', 'dance-solo', 'snack'];
const ACT_WHEN = ['night', 'sun', 'rain', 'near'];
// an act: { id, de, en, when?, near?, effect? }; anything else in it is dropped, a bad one is left out
export function safeAct(x) {
  if (!x || !ACTS.includes(x.id) || typeof x.de !== 'string' || typeof x.en !== 'string' || !x.de.trim() || !x.en.trim()) return null;
  return {
    id: x.id, de: x.de.slice(0, 80), en: x.en.slice(0, 80),
    ...(ACT_WHEN.includes(x.when) && { when: x.when }),
    ...(typeof x.near === 'string' && x.near && { near: x.near }),
    ...(ACTS.includes(x.effect) && { effect: x.effect }),
  };
}
export function safePersona(p) {
  return p && typeof p === 'object' && HOBBIES.includes(p.hobby) &&
    (p.favourite === null || typeof p.favourite === 'string') &&
    Array.isArray(p.likes) && Array.isArray(p.fears) ? {
      favourite: p.favourite ?? null,
      likes: p.likes.filter(x => typeof x === 'string').slice(0, 3),
      fears: p.fears.filter(x => typeof x === 'string').slice(0, 2),
      hobby: p.hobby,
      acts: (Array.isArray(p.acts) ? p.acts.map(safeAct).filter(Boolean) : []).slice(0, 3),
    } : null;
}
export const personaOf = id => personas[id] || null;
// quests (dialogues.json quests): who, title, start, solve { kind: help|bring|visit|wait, when }, lines; kinds checked here
const QUEST_KINDS = ['help', 'bring', 'visit', 'wait'];
export function safeQuest(q) {
  return q && typeof q.who === 'string' && q.start && typeof q.start.de === 'string' && typeof q.start.en === 'string' &&
    q.solve && QUEST_KINDS.includes(q.solve.kind);
}
export const questPool = () => quests;
// the pool and the personas are read from dialogues.json (at most once a minute); called by the sim, not only when a dialogue is picked
export async function refreshPool() {
  if (Date.now() - poolAt < 60_000) return;
  poolAt = Date.now();
  try {
    const r = await fetch('things/dialogues.json', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      pool = (j.dialogues || []).filter(safeDialogue);
      quests = (j.quests || []).filter(safeQuest);
      personas = Object.fromEntries(Object.entries(j.personas || {}).map(([id, p]) => [id, safePersona(p)]).filter(([, p]) => p));
    }
  } catch { /* no pool yet: templates only */ }
}
// a dialogue's optional when: { near, carrying, night (0-1, from this level on), weather, new }; no when fits any time
export function fitsWhen(when, c) {
  if (!when) return true;
  if (when.near !== undefined && !(c.near?.(when.near))) return false;
  if (when.carrying && !c.carrying) return false;
  if (when.night !== undefined && !(c.nightLevel >= when.night)) return false;
  if (when.weather !== undefined && !(c.weather || []).includes(when.weather)) return false;
  if (when.new !== undefined && !(c.isNew?.(when.new))) return false;
  return true;
}
// an unplayed generated dialogue for exactly these two, as { turns: [{ speaker, de, en }], end }; else null
export function fromPool(c) {
  refreshPool();
  const na = c.a.name || c.a.id, nb = c.b.name || c.b.id;
  const i = pool.findIndex(d => !played.has(contentKey(d)) && d.between.includes(na) && d.between.includes(nb) && na !== nb && fitsWhen(d.when, c));
  if (i < 0) return null;
  played.add(contentKey(pool[i]));
  const d = pool[i];
  return { end: d.end ?? null, generated: true, turns: d.turns.map(t => ({ speaker: t.who === na ? c.a : c.b, de: t.de, en: t.en })) };
}

// how long a speech bubble stays: long enough to read slowly (1.5 s plus ~6 letters a second), never shorter than asked
export const readTime = (text, dur = 2.4) => Math.max(dur, 1.5 + String(text || '').length / 6);
