// Camera picker: choose which camera watches the paper.
//  - "this computer": cameras of the machine the browser runs on (getUserMedia; needs https or localhost)
//  - "network": cameras shared by scripts/camera_server.py on Tailscale peers, found by serve.py
// The choice is kept in camera.json on the server (PUT /api/camera), so the capture stage knows it,
// and a small live preview shows what the chosen camera sees.
import { t } from './i18n.js';
// preview: the element that shows the live picture (the picture frame, camframe.js); the stream opens once, there
export function cameraPicker({ button, panel, preview = null }) {
  const select = panel.querySelector('select');
  const video = panel.querySelector('video');
  const img = panel.querySelector('img');
  if (preview) { preview.append(video, img); panel.querySelector('.note').textContent = ''; }
  const note = panel.querySelector('.note');
  let options = [], stream = null;

  const keyOf = c => c?.kind === 'local' || c?.kind === 'remote' ? (c.kind === 'local' ? 'local:' + c.label : `remote:${c.ip}:${c.id}`) : '';

  // "IPEVO V4K: IPEVO V4K" → "IPEVO V4K": the kernel repeats a name that already names the device
  const shortName = n => {
    const half = String(n || '').split(':').map(s => s.trim()).filter(Boolean);
    return half.length === 2 && half[0] === half[1] ? half[0] : String(n || '');
  };
  const optionLabel = c => c.kind === 'local' ? shortName(c.label) : `${shortName(c.name)} (${c.host})`;

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
      for (const c of list) g.append(new Option(optionLabel(c), keyOf(c)));
      return g;
    };
    // a local camera names itself, a network one carries the machine it sits on; the kernel's own
    // device name repeats itself ("IPEVO V4K: IPEVO V4K"), so a doubled half is dropped
    // the camera list is never empty-handed: this machine's own cameras first, then every server
    // that answers on the network; a group with nothing in it is left out rather than shown empty
    const groups = [[t('camHere'), local.cams], [t('camNetwork'), remote]]
      .filter(([, list]) => list.length)
      .map(([label, list]) => group(label, list));
    select.replaceChildren(new Option(t('camNone'), ''), ...groups);
    const want = keyOf(saved);
    select.value = options.some(c => keyOf(c) === want) ? want : '';
    // a local choice is stored as a label only (the browser's deviceId means nothing to the server),
    // so a reload cannot match it by key: fall back to the label, else the picker looks empty
    if (!select.value && saved?.kind === 'local' && saved.label) {
      const same = options.find(c => c.kind === 'local' &&
        (c.label === saved.label || shortName(c.label) === shortName(saved.label)));
      if (same) select.value = keyOf(same);
    }
    // only worth saying when it is true of the cameras that are actually on offer: a working
    // network camera with no local ones needs no warning next to a live picture
    const notes = [];
    if (!remote.length) {                     // nothing on the network: what this browser can offer is all there is
      notes.push(local.why || t('camNoRemote'));
    }
    note.textContent = notes.filter(Boolean).join(' ');
    if (saved && !select.value) note.textContent = `Gespeicherte Kamera nicht erreichbar: ${saved.label || saved.name}. ` + note.textContent;
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
      img.src = cam.stream + '?small&t=' + Date.now();   // the small preview: live over a thin link
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
