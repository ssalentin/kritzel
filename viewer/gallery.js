// The gallery: ◀ ▶ leaf back through the archived worlds in worlds/ (oldest first). The live
// world is the newest page; an archived one is read-only (serve.py refuses writes from it).
// Turning a page is a load of the next page, not an animation inside this one.
const here = location.pathname.match(/^\/worlds\/(\w[\w.-]*)\//);
const archived = await fetch('/api/worlds', { cache: 'no-store' }).then(r => r.json()).catch(() => []);
const pages = [...archived.map(n => `/worlds/${n}/`), '/viewer/'];
const at = here ? archived.indexOf(here[1]) : pages.length - 1;

if (pages.length > 1 && at >= 0) {
  const style = document.createElement('style');
  style.textContent = `#gallery { position: fixed; left: 16px; bottom: 16px; display: flex; gap: 6px; align-items: center; z-index: 5;
    font: 13px system-ui, sans-serif; }
    #gallery button { font: inherit; color: inherit; background: var(--panel, #fff9); border: 0; border-radius: 10px;
      padding: 6px 10px; cursor: pointer; opacity: .8; }
    #gallery button:disabled { opacity: .3; cursor: default; }
    #gallery span { padding: 0 4px; opacity: .75; }`;
  document.head.append(style);

  const bar = document.createElement('nav');
  bar.id = 'gallery';
  bar.setAttribute('aria-label', 'Galerie');
  const prev = document.createElement('button'), next = document.createElement('button'), label = document.createElement('span');
  prev.type = next.type = 'button';
  prev.textContent = '◀';
  next.textContent = '▶';
  prev.title = 'Vorherige Welt';
  next.title = 'Nächste Welt';
  label.textContent = here ? `📖 ${here[1]} · nur lesen` : '📖 jetzt';
  prev.disabled = at === 0;
  next.disabled = at === pages.length - 1;
  prev.addEventListener('click', () => { location.href = pages[at - 1]; });
  next.addEventListener('click', () => { location.href = pages[at + 1]; });
  bar.append(prev, label, next);
  document.body.append(bar);
}
