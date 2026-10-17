#!/usr/bin/env node
// A pool of short generated dialogues for the characters in the book (issue #9), on top of the authored
// templates in viewer/dialogues.js, and each figure's personality (what it likes, fears, keeps near, does).
// One cheap call per change writes viewer/things/dialogues.json (served with the things, archived with the
// world): { cast, model, made_at, reason, personas, dialogues }. The sim plays a dialogue when two of those
// characters meet (picking one whose "when" fits the moment) and never waits for a call. Every line passes the
// child-safe filter here and again before playback.
//
//   node generate/dialogues.mjs [--things DIR]     (the watcher runs it after new things)
import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneShot } from './claude.mjs';
import { safeDialogue, safeLine } from '../viewer/dialogues.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// the cheap fast model through pi (as live generation), Haiku when pi fails
export const POOL_MODEL = process.env.KRITZEL_DIALOGUE_MODEL || 'deepseek/deepseek-v4-flash';
export const POOL_FALLBACK = process.env.KRITZEL_DIALOGUE_FALLBACK || 'claude-haiku-5-5';
// the most dialogues kept in the pool: many pairs meet, and each dialogue plays once per page load
const POOL_MAX = 36;

const STR = `['"]([^'"]+)['"]`, PLAIN = `(?:\\s*\\w+:\\s*(?:'[^']*'|"[^"]*"|[\\w.-]+)\\s*,)*?`;

// the characters: every actor of every thing, with its name and what the thing is
export function castOf(thingsDir) {
  const cast = [];
  for (const file of readdirSync(thingsDir).filter(f => /^[\w.-]+\.js$/.test(f)).sort()) {
    const code = readFileSync(join(thingsDir, file), 'utf8');
    const drawing = code.match(/drawing:\s*['"]([^'"]+)['"]/)?.[1] || '';
    // id and name in either order, with short plain fields between them (id, move, name, ...)
    for (const m of code.matchAll(new RegExp(`\\bid:\\s*${STR}\\s*,${PLAIN}\\s*name:\\s*${STR}|\\bname:\\s*${STR}\\s*,${PLAIN}\\s*id:\\s*${STR}`, 'g'))) {
      const [id, name] = m[1] !== undefined ? [m[1], m[2]] : [m[4], m[3]];
      if (/^[\w-]+$/.test(id)) cast.push({ id, name, drawing });
    }
  }
  return cast;
}

// the things without figures (a tree, a pond, a cake): what a figure can like, fear or make its favourite place
export function thingsOf(thingsDir) {
  const ids = new Set(castOf(thingsDir).map(c => c.id)), out = [];
  for (const file of readdirSync(thingsDir).filter(f => /^[\w.-]+\.js$/.test(f)).sort()) {
    const code = readFileSync(join(thingsDir, file), 'utf8');
    const name = code.match(/\bmeta\s*=\s*\{[^}]*?\bname:\s*['"]([^'"]+)['"]/)?.[1];
    const actors = [...code.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].some(m => ids.has(m[1]));
    if (name && !actors) out.push({ file, name, drawing: code.match(/drawing:\s*['"]([^'"]+)['"]/)?.[1] || '' });
  }
  return out;
}

// the shape agreed with studio.world (the sim reads it): personas keyed by actor id; refs are a thing's or
// figure's meta.name (or an actor id); hobby is one the sim acts on; when only with keys the sim evaluates
export const HOBBIES = ['collect', 'guard', 'nap', 'follow', 'wander'];
const WEATHER = ['rain', 'snow', 'rainbow', 'lightning'];

const SYSTEM = `You write the characters of Kritzel, a living pop-up book of figures children drew on paper: who each one is, and short dialogues between them.
Reply with JSON only: { "personas": { <actor id>: { "favourite": <name> or null, "likes": [<name>, ...], "fears": [<name>, ...], "hobby": "collect" | "guard" | "nap" | "follow" | "wander", "lines": { "de": [...], "en": [...] } } }, "dialogues": [ { "between": [nameA, nameB], "when": { ... } (optional), "end": "stroll" | "dance" | "tag" | "look" | null, "turns": [ { "who": nameA or nameB, "de": German line, "en": English line } ] } ] }.
Personas: only for the figures asked for. Build each from what its drawing shows and from the things and figures around it in the book: its favourite place or thing (the centre of its attention), up to 3 it likes, up to 2 it is a little afraid of (gently: a cat and water, a mouse and the cat), a hobby (collect: picks up small things; guard: stays by its favourite; nap: rests at its favourite; follow: walks after one it likes; wander: roams), and 2 or 3 typical lines, the same in German and English. Every <name> is exactly one of the names listed.
Dialogues: 3 to 5 turns, the two take turns, every line answers the one before, and together they make a tiny scene that fits these two: their personas, their drawings, and the moment. "when" says when a dialogue fits, only with these keys: "near": <name> (they talk about a thing or figure next to them), "carrying": true (one of them carries something), "night": 0 to 1 (fits from this darkness on), "weather": "rain" | "snow" | "rainbow" | "lightning", "new": <name of a thing> (it just arrived in the book). A "when" names one moment only (one key), so it fits as soon as that moment comes. No "when" means any time; most dialogues have none. Lines are short (at most 60 characters), warm, playful and right for small children: no violence, no insults, nothing scary beyond a friendly "boo". German first, natural for children; "en" is short child-friendly English, not a word-for-word copy. In "between" and "who" use the figures' names (not their actor ids). They all live on the open pages of a big pop-up book: when a line mentions where they are, it is the book or its pages, never an island.`;

// model text → the agreed shape, or left out: unknown refs, hobbies and when keys are dropped, every line passes safeLine
export function cleanPersona(p, refs) {
  if (!p || typeof p !== 'object') return null;
  const ref = x => typeof x === 'string' && refs.has(x.toLowerCase()) ? x : null;
  const list = (a, n) => (Array.isArray(a) ? a : []).map(ref).filter(Boolean).slice(0, n);
  const lines = lang => (Array.isArray(p.lines?.[lang]) ? p.lines[lang] : []).filter(l => safeLine(l, lang)).slice(0, 3);
  const de = lines('de'), en = lines('en'), n = Math.min(de.length, en.length);
  return { favourite: ref(p.favourite), likes: list(p.likes, 3), fears: list(p.fears, 2), hobby: HOBBIES.includes(p.hobby) ? p.hobby : 'wander',
    lines: { de: de.slice(0, n), en: en.slice(0, n) } };
}
export function cleanWhen(w, refs, thingNames) {
  if (!w || typeof w !== 'object') return null;
  const out = {};
  if (typeof w.near === 'string' && refs.has(w.near.toLowerCase())) out.near = w.near;
  if (w.carrying === true) out.carrying = true;
  if (typeof w.night === 'number' && w.night >= 0 && w.night <= 1) out.night = +w.night.toFixed(2);
  if (WEATHER.includes(w.weather)) out.weather = w.weather;
  if (typeof w.new === 'string' && thingNames.has(w.new.toLowerCase())) out.new = w.new;   // things only, not figures
  return Object.keys(out).length ? out : null;
}

// the moment, in words for the model, from frames/status/situation.json (written by the viewer's sim). That
// file comes from a browser (PUT /api/situation): only names of the book's figures and things get into the
// prompt, at most 6 entries of a kind
export function momentOf(sit, newThings = [], refs = null) {
  const ok = x => typeof x === 'string' && x.length <= 40 && (!refs || refs.has(x.toLowerCase()));
  const list = a => (Array.isArray(a) ? a : []).slice(0, 6);
  const parts = [];
  for (const c of list(sit?.carrying)) if (ok(c?.who) && ok(c?.what)) parts.push(`${c.who} carries ${c.what}`);
  for (const t of list(sit?.thrown)) if (ok(t?.who) && ok(t?.what)) parts.push(`${t.who} throws ${t.what}${ok(t.to) ? ` to ${t.to}` : ''}`);
  if (typeof sit?.night === 'number' && sit.night >= 0.5) parts.push('it is night');
  for (const w of list(sit?.weather)) if (WEATHER.includes(w)) parts.push(`weather: ${w}`);
  for (const n of list(newThings)) if (ok(n)) parts.push(`${n} just arrived in the book`);
  return parts.join('; ');
}

// One call per change: personas for the figures that have none yet (a figure keeps its personality: it must not
// change its favourite with every refresh), and a fresh set of dialogues that fit the cast and the moment.
export async function makePool({ thingsDir = join(ROOT, 'viewer', 'things'), count = 12, model = POOL_MODEL, reason = '', situation = null, newThings = [] } = {}) {
  const cast = castOf(thingsDir), things = thingsOf(thingsDir);
  if (cast.length < 2) return { written: 0, reason: 'fewer than two characters' };
  const out = join(thingsDir, 'dialogues.json');
  let old = {};
  try { old = JSON.parse(readFileSync(out, 'utf8')); } catch { /* first pool */ }
  const ids = new Set(cast.map(c => c.id));
  const kept = Object.fromEntries(Object.entries(old.personas || {}).filter(([id]) => ids.has(id)));
  const want = cast.filter(c => !kept[c.id]);
  const refs = new Set([...cast.flatMap(c => [c.name, c.id]), ...things.map(t => t.name)].map(x => x.toLowerCase()));
  const thingNames = new Set(things.map(t => t.name.toLowerCase()));
  const moment = momentOf(situation, newThings, refs);
  const text = `The figures' names, to use exactly in "between" and "who" (no other names, not their actor ids): ${cast.map(c => c.name).join(', ')}.
The figures in the book now (actor id, name: drawing):
${cast.map(c => `- ${c.id}, ${c.name}: ${c.drawing}${kept[c.id] ? ` (persona: ${JSON.stringify(kept[c.id])})` : ''}`).join('\n')}
The things in the book (name: drawing):
${things.map(t => `- ${t.name}: ${t.drawing}`).join('\n') || '(none)'}
${moment ? `Right now: ${moment}.\n` : ''}
${want.length ? `Write personas for: ${want.map(c => c.id).join(', ')}.` : 'Every figure has its persona: write "personas": {}.'} Write ${count} dialogues, spread over different pairs${moment ? ', at most 4 of them for this moment (with a matching "when"), the rest for any time' : ''}.`;
  const t0 = Date.now();
  const r = await oneShot({ system: SYSTEM, text, images: [], model, fallback: POOL_FALLBACK, effort: 'low' });
  let j = {};
  try { j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch { /* unusable reply: keep what we had */ }
  const personas = { ...kept };
  for (const c of want) { const p = cleanPersona(j.personas?.[c.id], refs); if (p) personas[c.id] = p; }
  const names = new Set(cast.map(c => c.name));
  // the viewer matches figures by name: an actor id written instead is put back to its name
  const nameOf = Object.fromEntries(cast.map(c => [c.id, c.name])), named = n => nameOf[n] && !names.has(n) ? nameOf[n] : n;
  // what is safely fixable is fixed (an unknown end becomes none, more than 6 turns are cut to 6); the rest is
  // dropped with its reason, so the log says what DeepSeek gets wrong
  const ENDS = ['stroll', 'dance', 'tag', 'look'];
  const offered = (Array.isArray(j.dialogues) ? j.dialogues : []).map(d => d && Array.isArray(d.between) && Array.isArray(d.turns)
    ? { ...d, end: ENDS.includes(d.end) ? d.end : null, between: d.between.map(named), turns: d.turns.slice(0, 6).map(t => ({ ...t, who: named(t?.who) })) } : d);
  const why = d => {
    if (!d || !Array.isArray(d.between) || d.between.length !== 2 || !Array.isArray(d.turns)) return 'not a dialogue between two';
    const unknown = d.between.filter(n => !names.has(n));
    if (unknown.length) return `unknown name (${unknown.join(', ').slice(0, 40)})`;
    if (d.turns.length < 2) return 'fewer than 2 turns';
    if (d.turns.some(t => !d.between.includes(t?.who))) return 'a turn by someone else';
    const bad = d.turns.flatMap(t => [['de', t.de], ['en', t.en]]).find(([l, x]) => !safeLine(x, l));
    if (bad) return `line not allowed (${bad[0]}: ${String(bad[1] ?? '(none)').slice(0, 30)})`;
    return safeDialogue(d) ? null : 'shape';
  };
  const dropped = offered.map(why).filter(Boolean);
  const dialogues = offered.filter(d => !why(d))
    .map(d => { const when = cleanWhen(d.when, refs, thingNames); const { when: _, ...rest } = d; return when ? { ...rest, when } : rest; });
  // The pool grows instead of being replaced: the old dialogues for any time (no when) between figures still in
  // the book stay, the new ones come first, up to POOL_MAX. A moment's dialogues (with a when) are replaced by
  // the next call's: else every moment call would shrink what fits once the moment passes (QA: 12 -> 10 -> 8,
  // 7 of 8 with a when). An unusable reply keeps the old dialogues.
  const anyTime = (Array.isArray(old.dialogues) ? old.dialogues : []).filter(d => !d.when && safeDialogue(d) && d.between.every(n => names.has(n)));
  const seen = new Set(dialogues.map(d => JSON.stringify(d.turns)));
  const still = anyTime.filter(d => !seen.has(JSON.stringify(d.turns)));
  const pool = (dialogues.length ? [...dialogues, ...still] : Array.isArray(old.dialogues) ? old.dialogues : []).slice(0, POOL_MAX);
  writeFileSync(out + '.tmp', JSON.stringify({ cast: [...names].sort(), model: r.model, made_at: new Date().toISOString(), reason,
    personas, dialogues: pool }, null, 1));
  renameSync(out + '.tmp', out);
  return { written: dialogues.length, personas: Object.keys(personas).length - Object.keys(kept).length, offered: offered.length, ...(dropped.length && { dropped: [...new Set(dropped)].slice(0, 5) }),
    seconds: (Date.now() - t0) / 1000, cost: r.cost, model: r.model, ...(r.fellBack && { fellBack: r.fellBack }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
  const r = await makePool({ thingsDir: resolve(opt('--things', join(ROOT, 'viewer', 'things'))) });
  console.log(JSON.stringify(r));
}
