// The build queue, top left: which things the pipeline is building right now, in a child's words. The rows are
// generate's list (generate.things in /api/status). A finished row stays a few seconds, then fades; the whole
// list folds away when nothing is left.
import { t, lang } from './i18n.js';

const FADE_S = 4;                        // a finished row stays this long, then goes
const VANISH_S = 3;                      // the whole list goes this long after the last build ends
const WORD = { listed: 'buildWait', building: 'buildNow', draft: 'buildAlmost', done: 'buildDone', failed: 'buildFail' };

export function createBuildQueue(el) {
  const doneAt = new Map();              // row key → when it was first seen finished
  let busyUntil = 0;                     // the last time a thing was still being built (or waiting)
  let last = '';                         // what is on screen now: rebuilt only when it changes (update runs every frame)
  const say = x => typeof x === 'string' ? x : x?.[lang()] || x?.de || '';

  return {
    // called on every status update: st = both stages' status files, now = server clock (seconds)
    update(st, now = Date.now() / 1000) {
      const things = (st?.generate?.things || []).slice(0, 16);
      const shown = [];
      for (const th of things) {
        const key = JSON.stringify(th.name) + (th.file || '');
        if (th.state === 'done') {
          if (!doneAt.has(key)) doneAt.set(key, now);
          if (now - doneAt.get(key) > FADE_S) continue;      // finished and faded out
        } else doneAt.delete(key);
        shown.push({ name: say(th.name), state: th.state, key });
      }
      for (const k of [...doneAt.keys()]) if (!things.some(th => JSON.stringify(th.name) + (th.file || '') === k)) doneAt.delete(k);
      if (shown.some(r => r.state === 'listed' || r.state === 'building' || r.state === 'draft')) busyUntil = now;
      const gone = shown.length === 0 || now - busyUntil > VANISH_S && shown.every(r => r.state === 'done' || r.state === 'failed');
      el.hidden = gone;
      const key = gone ? '' : JSON.stringify(shown.map(r => [r.name, r.state]));
      if (key === last) return;                                            // same rows: no DOM churn, the dots keep beating
      last = key;
      if (gone) { el.replaceChildren(); return; }
      el.replaceChildren(...shown.map(r => {
        const row = document.createElement('div');
        row.className = 'row'; row.dataset.state = r.state;
        const dot = document.createElement('i'); dot.className = 'dot';        // a small progress dot: it beats while a thing is in the works
        const name = document.createElement('span'), label = document.createElement('span');
        name.className = 'name'; name.textContent = r.name;
        label.className = 'label'; label.textContent = t(WORD[r.state] || 'buildWait');
        row.append(dot, name, label);
        return row;
      }));
    },
  };
}
