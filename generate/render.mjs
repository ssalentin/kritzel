// Renders things in the real viewer (headless Chromium, software WebGL) and screenshots them,
// so the look step and people can see what a generated module actually looks like.
// A private static server serves viewer/ with things/ swapped for a scratch directory,
// so nothing touches the live viewer or its dev server.
import http from 'node:http';
import { createReadStream, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const VIEWER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'viewer');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };

function serve(thingsDir) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!url.startsWith('/viewer/')) { res.writeHead(404).end(); return; }
    const rel = normalize(url.slice('/viewer/'.length));
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    const inThings = rel === 'things' || rel.startsWith('things/');
    const base = inThings ? thingsDir : VIEWER;
    let p = join(base, inThings ? rel.slice('things'.length) : rel);
    if (existsSync(p) && statSync(p).isDirectory()) {
      if (!url.endsWith('/')) { res.writeHead(301, { Location: url + '/' }).end(); return; }
      if (inThings) {        // a directory listing like python's http.server: world.js parses the hrefs
        const files = readdirSync(p).filter(f => f.endsWith('.js'));
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(files.map(f => `<a href="${f}">${f}</a>`).join('\n'));
        return;
      }
      p = join(p, 'index.html');
    }
    if (!existsSync(p)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Last-Modified': statSync(p).mtime.toUTCString() });
    createReadStream(p).pipe(res);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

// One thing seen from the front, slightly from above (drawings are front views).
// focus: [x, z] where it stands. Software WebGL draws ~1 frame/s, so one view only.
// Returns { shots: [png paths], errors: [text in the viewer's error box + page errors] }.
export async function renderThing(thingsDir, outBase, { focus = [0, 0], height = 2 } = {}) {
  const server = await serve(thingsDir);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
    page.on('pageerror', e => errors.push('page: ' + e.message));
    const [x, z] = focus, d = Math.max(4.5, height * 2.4), ty = height * 0.45;
    const views = [['front', [x + d * 0.2, ty + d * 0.3, z + d]]];
    const shots = [];
    for (const [name, [cx, cy, cz]] of views) {
      const cam = [cx, cy, cz, x, ty, z].map(v => v.toFixed(2)).join(',');
      await page.goto(`http://127.0.0.1:${server.address().port}/viewer/?cam=${cam}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(6000);          // world build, the grow-in animation, a few sim ticks
      const box = (await page.locator('#err').textContent().catch(() => '')) || '';
      if (box.trim()) errors.push(...box.trim().split('\n'));
      const path = `${outBase}-${name}.png`;
      await page.screenshot({ path });
      shots.push(path);
    }
    return { shots, errors: [...new Set(errors)] };
  } finally {
    await browser.close();
    server.close();
  }
}
