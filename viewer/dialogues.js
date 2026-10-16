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
    ['a', 'Ganz neu auf der Insel. Komm, wir schauen!', 'It just arrived. Let\'s go look!'] ] },
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
    ['b', 'Ja! Die Insel ist so schön.', 'Yes! The island is so pretty.'],
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
const BAD = /\b(tot|töte\w*|sterb\w*|blut\w*|waffe\w*|schieß\w*|hass\w*|dumm\w*|idiot\w*|blöd\w*|scheiße?|kill\w*|dead|die[ds]?|blood\w*|gun\w*|shoot\w*|hate\w*|stupid|idiot\w*|shut up|sex\w*|drug\w*|alkohol\w*|alcohol)\b/i;
export function safeLine(s) { return typeof s === 'string' && s.length > 0 && s.length <= 90 && !BAD.test(s) && !/[<>{}]|https?:/.test(s); }
export function safeDialogue(d) {
  return d && Array.isArray(d.between) && d.between.length === 2 && Array.isArray(d.turns) && d.turns.length >= 2 && d.turns.length <= 6 &&
    d.turns.every(t => d.between.includes(t.who) && safeLine(t.de) && safeLine(t.en)) &&
    [null, 'stroll', 'dance', 'tag', 'look'].includes(d.end ?? null);
}

// ---------- the generated pool (things/dialogues.json next to placement.json, written by generate/dialogues.mjs) ----------
// { cast: [names], dialogues: [{ between: [nameA, nameB], end, turns: [{ who: name, de, en }] }] }
let pool = [], poolAt = 0;
const played = new Set();
async function refreshPool() {
  if (Date.now() - poolAt < 60_000) return;
  poolAt = Date.now();
  try {
    const r = await fetch('things/dialogues.json', { cache: 'no-store' });
    if (r.ok) pool = ((await r.json()).dialogues || []).filter(safeDialogue);
  } catch { /* no pool yet: templates only */ }
}
// an unplayed generated dialogue for exactly these two, as { turns: [{ speaker, de, en }], end }; else null
export function fromPool(c) {
  refreshPool();
  const na = c.a.name || c.a.id, nb = c.b.name || c.b.id;
  const i = pool.findIndex((d, k) => !played.has(k) && d.between.includes(na) && d.between.includes(nb) && na !== nb);
  if (i < 0) return null;
  played.add(i);
  const d = pool[i];
  return { end: d.end ?? null, generated: true, turns: d.turns.map(t => ({ speaker: t.who === na ? c.a : c.b, de: t.de, en: t.en })) };
}
