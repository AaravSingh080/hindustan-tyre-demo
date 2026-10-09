'use strict';

/* Builds a copy of the site that can be served as plain files, for GitHub Pages, which runs no server.

     node tools/build-pages.js --out _site                      for a site at the root of its address
     node tools/build-pages.js --out _site --base /repo-name    for a project site (user.github.io/repo-name/)

   The pages in this folder are written for the Node server: they ask for /css/..., /js/... and /api/... from the
   root of the site. A project site on GitHub Pages lives one folder down, so the copy has every one of those
   addresses moved under --base. Nothing in this folder is changed.

   Because no server answers there, the copy also gets one extra script, js/static-host.js, written here:
   - the chat answers from the same built-in list the server uses when no AI key is set (config/chatbot.json),
     with the very code the server runs, so the two cannot drift apart;
   - Compare gets the tyre list the server would have sent;
   - anything else that needs the server (signing in to the passport, the staff desk, the owner page) is told
     plainly that this is a preview. Nothing typed on those pages is sent anywhere.
   The copy is public and carries the shop's name, so it must never pass for the shop's own site:
   - every page says "Preview" across the top, in the page itself so it shows without scripts, and in its title;
   - a form that would post to the shop's real store (the newsletter sign-up) is switched off;
   - search engines are asked not to list it: the shop's real site should be the one found.

   The folder given to --out must be new or empty; this script never deletes anything. */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['index.html', 'tyres/index.html', 'compare/index.html', 'privacy/index.html', 'passport/index.html', 'staff/index.html', 'staff/job/index.html', 'admin/index.html'];
const FOLDERS = ['assets', 'css', 'js'];
// files on disk that no page uses any more
const LEFT_OUT = ['assets/video', 'assets/seq/tyre'];
// the first part of every address the site's own scripts and pages use from the root
const SITE_ROOTS = ['assets', 'css', 'js', 'tyres', 'compare', 'privacy', 'passport', 'staff', 'admin', 'api'];
// pages that are nothing without the server: they carry the preview strip
const SERVER_PAGES = ['passport', 'staff', 'admin'];

// '' for the root of a site, or '/name' (no slash at the end)
function normaliseBase(value) {
  const v = String(value || '').trim().replace(/\/+$/, '');
  if (v === '') return '';
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(v)) throw new Error(`--base must look like /repo-name, not "${value}"`);
  return v;
}

/* ---------- moving addresses under the base ---------- */

const underBase = (base, url) => (/^\/(?!\/)/.test(url) ? base + url : url);

/* ---------- saying that it is a preview ---------- */

const SHOP = 'https://hindustantyreagencies.com/';
// in the page's own head, because the home page does not load the stylesheet the app pages share; in the
// flow of the page, never stuck to the top, so it cannot sit over the header
const PREVIEW_STYLE = '<style>.preview-strip{position:relative;z-index:61;margin:0;padding:.55rem 1rem;background:#2b5fd9;color:#f4f4f0;font-size:1rem;line-height:1.4;text-align:center}'
  + '.preview-strip b{display:inline-block;margin-right:.5em;padding:.2em .5em .04em;background:#f4f4f0;color:#0d0d0e;border-radius:5px;font-family:var(--display,sans-serif);font-weight:600;font-size:1.15em;line-height:1;letter-spacing:.08em;text-transform:uppercase}'
  + '.preview-strip a{color:inherit;font-weight:600;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}'
  + '@media (max-width:600px){.preview-strip{font-size:.95rem}.preview-more{display:none}}'   // a phone gets the short form: two lines, not three
  + '.news-form [disabled]{opacity:.55;cursor:not-allowed}.news-off{margin-top:.8rem}</style>';
function previewStrip(page) {
  const text = SERVER_PAGES.includes(page.split('/')[0])
    ? 'A design demo, not the shop\u2019s live website. This page needs a server that is not running here: signing in does not work, and nothing you type on it is sent.'
    : 'A design demo, not the shop\u2019s live website.<span class="preview-more"> Buying, prices and offers are on the shop\u2019s own site.</span>';
  return `<p class="preview-strip" id="preview-strip" translate="no"><b>Preview</b>${text} <a href="${SHOP}">Open the shop\u2019s own site</a></p>`;
}

// a form that posts to another site would send what a visitor types to a real system (the newsletter form posts
// to the shop's store). In the copy it keeps its look and loses its address; its fields and its button are
// switched off, so neither a tap nor the Enter key can send anything, with or without scripts.
function formsOff(html) {
  const out = html.replace(/<form\b([^>]*?)\saction="(https?:\/\/[^"]*)"([^>]*)>([\s\S]*?)<\/form>/g, (m, before, action, after, inner) => {
    const attrs = (before + after).replace(/\smethod="[^"]*"/, '');
    const body = inner.replace(/<(input|button|select|textarea)\b([^>]*)>/g, (tag, name, rest) => (/\btype="hidden"|\bdisabled\b/.test(rest) ? tag : `<${name}${rest} disabled>`));
    return `<form${attrs} data-preview="off">${body}  <p class="news-off">Preview: sign-up is switched off here. <a class="text-link" href="${new URL(action).origin}/">Subscribe on the shop\u2019s own site</a>.</p>\n    </form>`;
  });
  if (/<form\b[^>]*\saction="(?:https?:)?\/\//.test(out)) throw new Error('a form that posts to another site is still in the copy');
  return out;
}

function rewriteHtml(html, base, page = 'index.html') {
  let out = html
    .replace(/\b(href|src|action|poster|data-full)="(\/(?!\/)[^"]*)"/g, (m, attr, url) => `${attr}="${base}${url}"`)
    .replace(/\bsrcset="([^"]*)"/g, (m, set) => `srcset="${set.split(',').map(part => part.replace(/^(\s*)(\S+)/, (x, gap, url) => gap + underBase(base, url))).join(',')}"`);
  // the preview is not for search engines, and the script that stands in for the server loads before anything asks for it
  const head = `<meta charset="utf-8">\n<meta name="robots" content="noindex">\n<script src="${base}/js/static-host.js"></script>\n${PREVIEW_STYLE}`;
  if (!out.includes('<meta charset="utf-8">')) throw new Error(`${page}: no <meta charset="utf-8"> to hang the preview head on`);
  out = out.replace('<meta charset="utf-8">', head);
  // said in the page itself, right after the skip link, and in the name of the tab and of a shared link
  if (!/<a class="skip"[^>]*>[^<]*<\/a>/.test(out)) throw new Error(`${page}: no skip link to put the preview strip after`);
  out = out.replace(/(<a class="skip"[^>]*>[^<]*<\/a>)/, `$1\n${previewStrip(page)}`);
  if (!/<title>[^<]+<\/title>/.test(out)) throw new Error(`${page}: no title to mark as a preview`);
  out = out.replace(/<title>([^<]+)<\/title>/, '<title>Preview: $1</title>').replace(/(<meta property="og:title" content=")([^"]*")/, '$1Preview: $2');
  return formsOff(out);
}

// only addresses that start with one of the site's own folders: '/search?...' and the like belong to the shop's site
const JS_ROOT = new RegExp(`(['"\`])/(${SITE_ROOTS.join('|')})(?=[/'"\`?#])`, 'g');
const rewriteJs = (js, base) => js.replace(JS_ROOT, (m, quote, root) => `${quote}${base}/${root}`);
const rewriteCss = (css, base) => css.replace(/url\((['"]?)(\/(?!\/))/g, (m, quote, slash) => `url(${quote}${base}${slash}`);

/* ---------- what the server would have answered ---------- */

// asked of the real server, started for a moment with no keys set, so the copy cannot disagree with it
async function serverAnswers() {
  const { createApp } = require('../server/app');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-pages-'));
  const app = createApp({ env: { DATA_DIR: dataDir }, log: () => {} });
  const server = http.createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = async p => {
    const res = await fetch(`http://localhost:${server.address().port}${p}`, { headers: { 'x-hta': '1' } });
    if (!res.ok) throw new Error(`${p} answered ${res.status}`);
    return res.json();
  };
  try {
    const [chat, tyres, config, me] = [await get('/api/chat/config'), await get('/api/public/tyres'), await get('/api/public/config'), await get('/api/me')];
    if (me.signedIn !== false) throw new Error('/api/me did not answer as it does for a visitor who is not signed in');
    // no server, so nobody can sign in: no demo numbers, no demo PIN, and the passport says sign-in is off
    delete config.demo;
    return { chat: { ...chat, ai: false }, tyres, config: { ...config, mode: 'preview', signIn: 'off' }, me };
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    app.close();
  }
}

// the built-in answerer, lifted out of server/chat.js as it is written there
function answererSource() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'chat.js'), 'utf8');
  const from = src.indexOf('/* ---------- the built-in answerer ---------- */');
  const to = src.indexOf('/* ---------- Claude ---------- */');
  if (from < 0 || to < from) throw new Error('server/chat.js: the built-in answerer is not where this script looks for it');
  const code = src.slice(from, to).trim();
  if (/\brequire\(|\bprocess\.|\bfs\./.test(code)) throw new Error('server/chat.js: the built-in answerer now needs something a browser does not have');
  return code;
}

function staticHost(base, answers) {
  const { readKnowledge } = require('../server/chat');
  const k = readKnowledge(path.join(ROOT, 'config', 'chatbot.json'));
  const data = { ...answers, answers: { faq: k.faq.map(f => ({ words: f.words, answer: f.answer })), fallback: k.fallback } };
  return `/* Written by tools/build-pages.js. Not part of the site as the shop runs it.
   This copy is served as plain files, so no server answers. This script stands in for it: the chat answers
   from the shop's built-in list, Compare gets its tyre list, and everything else that needs the server is told
   that this is a preview. Nothing typed on this copy is sent anywhere. */
(function () {
  'use strict';
  const BASE = ${JSON.stringify(base)};
  const DATA = ${JSON.stringify(data)};

  ${answererSource().split('\n').join('\n  ')}

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  const reply = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  const NO_SERVER = { error: { code: 'preview', message: 'This is a preview of the design. This part needs the shop\\u2019s server, which is not running here.' } };
  // the part of an address after the base, when it is one of the site's own /api/ addresses
  const routeOf = input => {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin !== location.origin) return null;
      const p = BASE && url.pathname.startsWith(BASE + '/') ? url.pathname.slice(BASE.length) : url.pathname;
      return p.startsWith('/api/') ? p : null;
    } catch (e) { return null; }
  };
  if (realFetch) window.fetch = function (input, init) {
    const route = routeOf(input);
    if (!route) return realFetch(input, init);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (route === '/api/chat/config' && method === 'GET') return reply(200, DATA.chat);
    if (route === '/api/public/tyres' && method === 'GET') return reply(200, DATA.tyres);
    if (route === '/api/public/config' && method === 'GET') return reply(200, DATA.config);
    if (route === '/api/me' && method === 'GET') return reply(200, DATA.me);   // nobody is signed in
    if (route === '/api/stat') return reply(200, { ok: true });
    if (route === '/api/chat' && method === 'POST') {
      let text = '';
      try { const turns = JSON.parse(init.body).messages; text = String(turns[turns.length - 1].text || ''); } catch (e) { /* answered with the fallback */ }
      return reply(200, { text: localAnswer(DATA.answers, text) });
    }
    return reply(503, NO_SERVER);
  };

  // a link written from the root of the site that the build could not see (a page named inside a chat answer)
  // is pointed inside the preview before the browser follows it
  if (BASE) {
    const inside = event => {
      const a = event.target instanceof Element && event.target.closest('a[href]');
      const raw = a && a.getAttribute('href');
      if (raw && /^\\/(?!\\/)/.test(raw) && raw !== BASE && !raw.startsWith(BASE + '/')) a.setAttribute('href', BASE + raw);
    };
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'focusin', 'click']) document.addEventListener(type, inside, true);
  }

  // The passport's "sign-in is off" panel was written for a live server that is waiting for its SMS key, and
  // tells the reader to call the shop for their tyre details. Here there are no records and no such service:
  // the panel says that instead of sending anyone to the shop's phone.
  const signInPanel = () => {
    const off = document.getElementById('signin-off');
    if (!off) return;
    off.setAttribute('translate', 'no');
    const title = off.querySelector('h2'), text = off.querySelector('p');
    if (title) title.textContent = 'Not part of this preview';
    if (text) text.textContent = 'Signing in needs the shop\\u2019s server. This preview holds no customer records.';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', signInPanel); else signInPanel();
})();
`;
}

const notFound = base => `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Preview: Page not found | Hindustan Tyre Agencies</title>
<meta name="theme-color" content="#0d0d0e">
<link rel="icon" href="${base}/assets/img/logo.png">
<link rel="stylesheet" href="${base}/css/styles.css">
<link rel="stylesheet" href="${base}/css/passport.css">
${PREVIEW_STYLE}
</head>
<body class="app">
${previewStrip('404.html')}
<main id="main" class="app-main">
  <p class="kicker">Error 404</p>
  <h1 class="display">Wrong <em>turn.</em></h1>
  <p class="lede">That page is not on this site. The way back is below.</p>
  <p><a class="plate" href="${base}/"><span class="plate-txt">Back to the start</span></a></p>
  <p><a class="text-link" href="${base}/tyres/">Find my tyres</a></p>
</main>
</body>
</html>
`;

/* ---------- the build ---------- */

function copyFolder(from, to, rel, base, written, opts) {
  if (LEFT_OUT.includes(rel)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dest = path.join(to, entry.name), r = rel + '/' + entry.name;
    if (entry.isDirectory()) { copyFolder(src, dest, r, base, written, opts); continue; }
    if (/\.js$/.test(entry.name)) fs.writeFileSync(dest, rewriteJs(fs.readFileSync(src, 'utf8'), base));
    else if (/\.css$/.test(entry.name)) fs.writeFileSync(dest, rewriteCss(fs.readFileSync(src, 'utf8'), base));
    else if (opts.assets === false) continue;   // a dry run for the tests: pictures, frames and fonts are left where they are
    else fs.copyFileSync(src, dest);
    written.push(r);
  }
}

// out: a new or empty folder. base: '' or '/name'. assets: false skips pictures, frames and fonts.
async function build({ out, base = '', assets = true, log = () => {} } = {}) {
  if (!out) throw new Error('--out <folder> is required');
  base = normaliseBase(base);
  out = path.resolve(out);
  if (out === ROOT || ROOT.startsWith(out + path.sep)) throw new Error('--out must not be the project folder or a folder above it');
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty: give a new folder (this script deletes nothing)`);
  fs.mkdirSync(out, { recursive: true });

  const written = [];
  for (const page of PAGES) {
    const dest = path.join(out, page);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewriteHtml(fs.readFileSync(path.join(ROOT, page), 'utf8'), base, page));
    written.push(page);
  }
  for (const folder of FOLDERS) copyFolder(path.join(ROOT, folder), path.join(out, folder), folder, base, written, { assets });

  fs.writeFileSync(path.join(out, 'js', 'static-host.js'), staticHost(base, await serverAnswers()));
  fs.writeFileSync(path.join(out, '404.html'), notFound(base));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  // the fonts' licence asks to travel with every copy of the fonts
  fs.copyFileSync(path.join(ROOT, 'THIRD-PARTY-LICENSES.txt'), path.join(out, 'THIRD-PARTY-LICENSES.txt'));
  written.push('js/static-host.js', '404.html', '.nojekyll', 'THIRD-PARTY-LICENSES.txt');
  log(`${written.length} files written to ${out}${base ? `, to be served under ${base}/` : ''}`);
  return { out, base, written };
}

if (require.main === module) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  build({ out: arg('--out'), base: arg('--base') !== undefined ? arg('--base') : process.env.PAGES_BASE || '', log: console.log })
    .catch(e => { console.error('Preview not built:', e.message); process.exit(1); });
}

module.exports = { build, rewriteHtml, rewriteJs, rewriteCss, normaliseBase, PAGES, SITE_ROOTS, LEFT_OUT, SERVER_PAGES };
