'use strict';

/* Serves a folder built by tools/build-pages.js the way GitHub Pages would: plain files only, under the base
   it was built for, 404.html for anything missing, and no answer to anything but a read.

     node tools/build-pages.js --out ../preview --base /repo-name
     node tools/preview-pages.js ../preview --base /repo-name          then open http://localhost:4180/repo-name/

   For checking the copy on this computer before it is pushed. */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = path.resolve(process.argv[2] || '');
const base = String(arg('--base') || '').replace(/\/+$/, '');
const port = Number(arg('--port') || process.env.PORT || 4180);
if (!process.argv[2] || !fs.existsSync(path.join(dir, 'index.html'))) { console.error('Give the folder that tools/build-pages.js wrote.'); process.exit(1); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.csv': 'text/csv; charset=utf-8', '.mp4': 'video/mp4' };
const send = (res, status, file) => {
  res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (base && url.pathname === base) { res.writeHead(301, { location: base + '/' }); return res.end(); }
  const missing = () => send(res, 404, path.join(dir, '404.html'));
  if (base && !url.pathname.startsWith(base + '/')) return missing();
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice(base.length)); } catch (e) { return missing(); }
  let file = path.join(dir, rel);
  if (!file.startsWith(dir)) return missing();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!rel.endsWith('/')) { res.writeHead(301, { location: url.pathname + '/' + url.search }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return missing();
  send(res, 200, file);
}).listen(port, () => console.log(`Preview at http://localhost:${port}${base}/`));
