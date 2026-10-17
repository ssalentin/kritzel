// The live camera in a picture frame, bottom right, with the pipeline's words under it: "Bitte liegen lassen"
// while capture waits for the paper to be still, then "Du kannst das Blatt jetzt wegnehmen!" once generate has
// the settled picture. The picture is the camera picker's own element (camera.js moves it here), so one stream
// serves both; with no camera chosen the frame says so. The caption is the status pill's words otherwise.
import { t } from './i18n.js';

const DONE_S = 15;                       // "you can take the paper away" stays this long after the picture is taken
const MIN_KEY = 'kritzelFrameMin';

export function createCamFrame(el) {
  const cap = el.querySelector('.txt'), none = el.querySelector('.none'), min = el.querySelector('.min');
  let minimised = false, doneFor = null, doneAt = -Infinity;
  try { minimised = localStorage.getItem(MIN_KEY) === '1'; } catch {}
  const showMin = () => { el.dataset.min = minimised ? '1' : ''; min.textContent = minimised ? '▣' : '–'; min.setAttribute('aria-expanded', String(!minimised)); };
  min.addEventListener('click', () => {
    minimised = !minimised;
    try { localStorage.setItem(MIN_KEY, minimised ? '1' : '0'); } catch {}
    showMin();
  });
  showMin();
  return {
    pic: el.querySelector('.pic'),
    // called by status.js after every pill update: v = { tone, text }, st = both stages' status files
    update(v, st) {
      const c = st?.capture || {}, g = st?.generate || {};
      const hold = !!c.alive && c.state === 'moving';                                   // capture waits for the paper to be still
      const taken = !!c.alive && !!c.last && g.frame === c.last.frame && !(g.alive && g.state === 'building');
      const now = performance.now();
      if (taken && g.frame !== doneFor) { doneFor = g.frame; doneAt = now; }           // a newly settled picture: say so once
      const done = !hold && taken && now - doneAt < DONE_S * 1000;
      const mode = hold ? 'hold' : done ? 'done' : 'live';
      if (el.dataset.mode !== mode) el.dataset.mode = mode;
      const text = hold ? t('camHold') : done ? t('camDone') : v.text;
      if (cap.textContent !== text) cap.textContent = text;
      if (none.textContent !== t('camNone')) none.textContent = t('camNone');
    },
  };
}
