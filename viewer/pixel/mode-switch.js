// A render-mode change owns the world: first tap arms, second archives and starts the other mode empty.
import { onLang, t } from '../i18n.js';

export function createModeSwitch({ active, group, archived = false, go, onError = () => {} }) {
  const buttons = [...group.querySelectorAll('button')];
  let armed = null, busy = false;
  const show = () => {
    group.setAttribute('aria-label', t('renderModeGroup'));
    for (const button of buttons) {
      const mode = button.dataset.mode;
      button.textContent = busy ? t('switchingWorld') : armed === mode ? t('sure') : mode === 'pixel' ? t('modePixel') : t('mode3d');
      button.setAttribute('aria-pressed', String(mode === active));
      button.disabled = busy;
      button.classList.toggle('sure', armed === mode && !busy);
    }
  };
  const click = async event => {
    const button = event.target.closest('button[data-mode]');
    if (!button || busy) return;
    if (button.dataset.mode === active) { armed = null; show(); return; }
    const mode = button.dataset.mode;
    if (armed !== mode) { armed = mode; show(); return; }
    busy = true; show();
    try {
      const r = await fetch('/api/render-mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kritzel': '1' },
        body: JSON.stringify({ mode }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t('modeFailed'));
      go(mode);
    } catch {
      armed = null; busy = false; show(); onError();
    }
  };
  group.hidden = archived;
  if (!archived) group.addEventListener('click', click);
  onLang(show);
  show();
  return { show };
}
