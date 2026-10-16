#!/usr/bin/env node
// A pool of short generated dialogues for the characters on the island (issue #9), on top of the
// authored templates in viewer/dialogues.js. One cheap headless call writes ~12 dialogues for the
// current cast to viewer/things/dialogues.json (served with the things, archived with the world); the viewer plays them when two of those characters meet
// and never waits for a call. Every line passes the child-safe filter here and again before playback.
//
//   node generate/dialogues.mjs [--things DIR]     (the watcher runs it after new things)
import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneShot } from './claude.mjs';
import { safeDialogue } from '../viewer/dialogues.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POOL_MODEL = process.env.KRITZEL_DIALOGUE_MODEL || 'claude-haiku-5-5';

// the characters: every actor of every thing, with its name and what the thing is
export function castOf(thingsDir) {
  const cast = [];
  for (const file of readdirSync(thingsDir).filter(f => /^[\w.-]+\.js$/.test(f)).sort()) {
    const code = readFileSync(join(thingsDir, file), 'utf8');
    const drawing = code.match(/drawing:\s*['"]([^'"]+)['"]/)?.[1] || '';
    for (const [, id, name] of code.matchAll(/\bid:\s*['"]([\w-]+)['"]\s*,\s*name:\s*['"]([^'"]+)['"]/g)) cast.push({ id, name, drawing });
  }
  return cast;
}

const SYSTEM = `You write short dialogues for Kritzel, a living pop-up book of characters children drew on paper.
Reply with JSON only: { "dialogues": [ { "between": [nameA, nameB], "end": "stroll" | "dance" | "tag" | "look" | null, "turns": [ { "who": nameA or nameB, "de": German line, "en": English line } ] } ] }.
Each dialogue: 3 to 5 turns, the two take turns, every line answers the one before, and together they make a tiny scene that fits these two (what they are, what they look like) and can end in something they do together ("end"). Lines are short (at most 60 characters), warm, playful and right for small children: no violence, no insults, nothing scary beyond a friendly "boo". German first, natural for children; "en" is short child-friendly English, not a word-for-word copy. Use the characters' names as given. They all live on the open pages of a big pop-up book: when a line mentions where they are, it is the book or its pages, never an island.`;

export async function makePool({ thingsDir = join(ROOT, 'viewer', 'things'), count = 12, model = POOL_MODEL } = {}) {
  const cast = castOf(thingsDir);
  if (cast.length < 2) return { written: 0, reason: 'fewer than two characters' };
  const text = `The characters in the book now:\n${cast.map(c => `- ${c.name}: ${c.drawing}`).join('\n')}\n\nWrite ${count} dialogues, spread over different pairs of these characters.`;
  const t0 = Date.now();
  const r = await oneShot({ system: SYSTEM, text, images: [], model, effort: 'low' });
  let list = [];
  try { list = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)).dialogues || []; } catch { /* unusable reply: no pool */ }
  const names = new Set(cast.map(c => c.name));
  const ok = list.filter(d => safeDialogue(d) && d.between.every(n => names.has(n)));
  const out = join(thingsDir, 'dialogues.json');
  writeFileSync(out + '.tmp', JSON.stringify({ cast: [...names].sort(), model, made_at: new Date().toISOString(), dialogues: ok }, null, 1));
  renameSync(out + '.tmp', out);
  return { written: ok.length, offered: list.length, seconds: (Date.now() - t0) / 1000, cost: r.cost, model };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
  const r = await makePool({ thingsDir: resolve(opt('--things', join(ROOT, 'viewer', 'things'))) });
  console.log(JSON.stringify(r));
}
