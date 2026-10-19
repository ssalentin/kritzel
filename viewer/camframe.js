// The live camera in a picture frame, bottom right, with the pipeline's words under it: "Bitte liegen lassen"
// while capture waits for the paper to be still, then "Du kannst das Blatt jetzt wegnehmen!" once generate has
// the settled picture. The picture is the camera picker's own element (camera.js moves it here), so one stream
// serves both; with no camera chosen the frame says so. The caption is the status pill's words otherwise.
import { t } from './i18n.js';

const DONE_S = 15;                       // "you can take the paper away" stays this long after capture settles a picture
const MIN_KEY = 'kritzelFrameMin';

export function createCamFrame(el) {
  const cap = el.querySelector('.txt'), none = el.querySelector('.none'), min = el.querySelector('.min');
  let minimised = false;
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
      const c = st?.capture || {}, now = st?.now ?? Date.now() / 1000;                 // server clock, as in status.js
      // no picture (no camera chosen, or it is off): no paper hint at all
      const camOn = [...el.querySelectorAll('.pic video, .pic img')].some(x => !x.hidden);
      const hold = camOn && !!c.alive && c.state === 'moving';                          // capture waits for the paper to be still
      const hand = hold && c.detail === 'hand on the paper';
      // capture has settled a picture: the paper can go (generate already has the JPG)
      const done = camOn && !hold && !!c.alive && c.state === 'watching' && !!c.last && now - c.last.at < DONE_S;
      const mode = hold ? 'hold' : done ? 'done' : 'live';
      if (el.dataset.mode !== mode) el.dataset.mode = mode;
      const text = hand ? t('handOnPaper') : hold ? t('camHold') : done ? t('camDone') : v.text;
      if (cap.textContent !== text) cap.textContent = text;
      if (none.textContent !== t('camNone')) none.textContent = t('camNone');
    },
  };
}
