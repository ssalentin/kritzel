// Camera picker: choose which camera watches the paper.
//  - "this computer": cameras of the machine the browser runs on (getUserMedia; needs https or localhost)
//  - "network": cameras shared by scripts/camera_server.py on Tailscale peers, found by serve.py
// The choice is kept in camera.json on the server (PUT /api/camera), so the capture stage knows it,
// and a small live preview shows what the chosen camera sees.
import { t } from './i18n.js';
export function cameraPicker({ button, panel }) {
  const select = panel.querySelector('select');
  const video = panel.querySelector('video');
  const img = panel.querySelector('img');
  const note = panel.querySelector('.note');
  let options = [], stream = null;

  const keyOf = c => c?.kind === 'local' || c?.kind === 'remote' ? (c.kind === 'local' ? 'local:' + c.label : `remote:${c.ip}:${c.id}`) : '';

  async function localCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return { cams: [], why: t('camHttps') };
    let devs = await navigator.mediaDevices.enumerateDevices();
    // labels stay empty until the page may use a camera: ask once
    if (devs.some(d => d.kind === 'videoinput' && !d.label)) {
      try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach(t => t.stop()); } catch {}
      devs = await navigator.mediaDevices.enumerateDevices();
    }
    const cams = devs.filter(d => d.kind === 'videoinput' && d.deviceId)
      .map((d, i) => ({ kind: 'local', deviceId: d.deviceId, label: d.label || `Kamera ${i + 1}` }));
    return { cams, why: cams.length ? '' : t('camNoLocal') };
  }

  async function refresh() {
    note.textContent = t('camSearching');
    const [local, remote, saved] = await Promise.all([
      localCameras().catch(e => ({ cams: [], why: e.message })),
      fetch('/api/cameras', { cache: 'no-store' }).then(r => r.json()).catch(() => []),
      fetch('/api/camera', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
    ]);
    options = [...local.cams, ...remote];
    const group = (label, list) => {
      const g = document.createElement('optgroup');
      g.label = label;
      for (const c of list) g.append(new Option(c.kind === 'local' ? c.label : `${c.name} (${c.host})`, keyOf(c)));
      return g;
    };
    select.replaceChildren(new Option(t('camNone'), ''), group(t('camHere'), local.cams), group(t('camNetwork'), remote));
    const want = keyOf(saved);
    select.value = options.some(c => keyOf(c) === want) ? want : '';
    note.textContent = [local.why, remote.length ? '' : t('camNoRemote')]
      .filter(Boolean).join(' ');
    if ((saved?.kind === 'local' || saved?.kind === 'remote') && !select.value) note.textContent = `Gespeicherte Kamera nicht erreichbar: ${saved.label || saved.name}. ` + note.textContent;
    await show(options.find(c => keyOf(c) === select.value));
  }

  async function show(cam) {
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    video.hidden = img.hidden = true;
    img.removeAttribute('src');
    if (!cam) return;
    if (cam.kind === 'local') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId } } });
        video.srcObject = stream;
        video.hidden = false;
      } catch (e) { note.textContent = t('camCantOpen') + e.message; }
    } else {
      img.onerror = () => { img.hidden = true; note.textContent = `${cam.name} (${cam.host}) sendet kein Bild.`; };
      img.src = cam.stream + '?t=' + Date.now();
      img.hidden = false;
    }
  }

  select.addEventListener('change', async () => {
    const cam = options.find(c => keyOf(c) === select.value) || null;
    note.textContent = '';
    await show(cam);
    // the browser-only deviceId means nothing to the server; keep the label instead
    const saved = cam && (cam.kind === 'local' ? { kind: 'local', label: cam.label } : cam);
    await fetch('/api/camera', { method: 'PUT', body: JSON.stringify(saved || { kind: 'none' }) }).catch(() => {});
  });
  panel.querySelector('.refresh').addEventListener('click', refresh);
  button.addEventListener('click', e => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !options.length) refresh();
  });
  // a saved choice comes back on its own after a reload
  fetch('/api/camera', { cache: 'no-store' }).then(r => r.json()).then(c => { if (c?.label || c?.id) refresh(); }).catch(() => {});
}
