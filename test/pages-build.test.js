'use strict';

/* The copy of the site made for GitHub Pages (tools/build-pages.js): every address is moved under the base the
   site will be served from, nothing points at a file that is not there (in the exact spelling, as a Linux host
   needs), the script that stands in for the server answers as the server would, and what goes public holds no
   server code and no secrets. */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { build, rewriteHtml, rewriteJs, rewriteCss, normaliseBase, PAGES, SERVER_PAGES } = require('../tools/build-pages');
const { readKnowledge, localAnswer } = require('../server/chat');
const { readTyres } = require('../server/tyres');

const ROOT = path.resolve(__dirname, '..');
const BASE = '/shop-preview';
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
// true only when every part of the path is spelled exactly as it is on disk
const exact = (root, rel) => {
  let dir = root;
  for (const part of rel.split('/').filter(Boolean)) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || !fs.readdirSync(dir).includes(part)) return false;
    dir = path.join(dir, part);
  }
  return true;
};
const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? walk(dir, `${rel}${e.name}/`) : [rel + e.name]));

describe('the copy for GitHub Pages', () => {
  let out, files;
  before(async () => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-pages-test-'));
    // a dry run: pages, styles and scripts are written; pictures, frames and fonts are checked where they already are
    ({ written: files } = await build({ out: path.join(out, 'site'), base: BASE, assets: false }));
    out = path.join(out, 'site');
  });

  test('the base is a folder name or nothing, and anything else is refused', () => {
    assert.equal(normaliseBase(''), '');
    assert.equal(normaliseBase(undefined), '');
    assert.equal(normaliseBase('/repo-name/'), '/repo-name');
    assert.equal(normaliseBase('/a/b'), '/a/b');
    for (const bad of ['repo', 'C:/Program Files/Git/repo', '/has space', '/a"b', '//host']) assert.throws(() => normaliseBase(bad), /--base/, bad);
  });

  test('addresses from the root of the site move under the base; the shop\'s own addresses and other sites do not', () => {
    const html = rewriteHtml('<meta charset="utf-8"><title>T</title><a class="skip" href="#main">Skip</a><a href="/">x</a><img src="/assets/a.webp" srcset="/assets/a.webp 1x, /assets/b.webp 2x"><a href="//cdn.example/x">y</a><a href="https://wa.me/1">z</a><a href="tyres/">t</a>', BASE);
    assert.ok(html.includes(`href="${BASE}/"`) && html.includes(`src="${BASE}/assets/a.webp"`));
    assert.ok(html.includes(`srcset="${BASE}/assets/a.webp 1x, ${BASE}/assets/b.webp 2x"`));
    assert.ok(html.includes('href="//cdn.example/x"') && html.includes('href="https://wa.me/1"') && html.includes('href="tyres/"'));
    const js = rewriteJs("fetch('/api/me'); x = `/assets/img/${a}.webp`; go('/staff/'); y = '/search?q=1'; z = BASE + '/collections/all/'; re = /\\/tyres\\//; w = '/admin/#stock';", BASE);
    assert.ok(js.includes(`fetch('${BASE}/api/me')`) && js.includes('`' + BASE + '/assets/img/${a}.webp`') && js.includes(`go('${BASE}/staff/')`) && js.includes(`'${BASE}/admin/#stock'`));
    assert.ok(js.includes("'/search?q=1'") && js.includes("'/collections/all/'") && js.includes('/\\/tyres\\//'), 'what belongs to the shop\'s site, and patterns, are left alone');
    assert.equal(rewriteCss('a{background:url(/assets/x.webp)} b{background:url("../assets/y.webp")}', BASE), `a{background:url(${BASE}/assets/x.webp)} b{background:url("../assets/y.webp")}`);
    // a site at the root of its own address is left exactly as written
    assert.equal(rewriteJs("fetch('/api/me')", ''), "fetch('/api/me')");
  });

  test('every page is there, asks not to be listed, and loads the stand-in for the server before anything else', () => {
    for (const page of PAGES) {
      const html = read(out, page);
      assert.match(html, /<meta name="robots" content="noindex">/, page);
      const shim = html.indexOf(`<script src="${BASE}/js/static-host.js"></script>`);
      assert.ok(shim > 0, `${page} loads the stand-in`);
      const others = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].filter(m => !m[1].endsWith('static-host.js'));
      for (const m of others) assert.ok(m.index > shim, `${page}: ${m[1]} loads after the stand-in`);
    }
    assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
    assert.match(read(out, '404.html'), new RegExp(`href="${BASE}/"`));
  });

  test('no page can pass for the shop\'s own site: each says Preview in the page itself, in its title, and names the real site', () => {
    for (const page of [...PAGES, '404.html']) {
      const html = read(out, page);
      // written into the page, so it shows with scripts off
      const strip = /<p class="preview-strip" id="preview-strip" translate="no"><b>Preview<\/b>((?:[^<]|<span class="preview-more">[^<]*<\/span>)+) <a href="https:\/\/hindustantyreagencies\.com\/">Open the shop\u2019s own site<\/a><\/p>/.exec(html);
      assert.ok(strip, `${page} carries the strip`);
      assert.match(strip[1], /A design demo, not the shop\u2019s live website\./, page);
      if (page !== '404.html') assert.match(html, /<a class="skip"[^>]*>[^<]*<\/a>\n<p class="preview-strip"/, `${page}: the strip follows the skip link`);
      assert.ok(html.indexOf('preview-strip"') < html.indexOf('<main'), `${page}: the strip comes before the content`);
      assert.match(html, /<title>Preview: [^<]+<\/title>/, page);
      assert.match(html, /<style>\.preview-strip\{position:relative;/, `${page} styles the strip itself and never sticks it over the header`);
      assert.doesNotMatch(strip[1], /[\u2013\u2014]/, 'no dashes in page copy');
      // only the pages that need the server say that signing in does not work
      assert.equal(/signing in does not work/.test(strip[1]), SERVER_PAGES.includes(page.split('/')[0]), page);
    }
    assert.match(read(out, 'index.html'), /<meta property="og:title" content="Preview: /, 'a shared link says so too');
  });

  test('nothing a visitor types can reach the shop\'s real store: the newsletter form is switched off in the copy', () => {
    const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(source, /<form class="news-form" id="news-form" method="post" action="https:\/\/hindustantyreagencies\.com\//, 'on the shop\'s own deployment the form posts to the store, as before');
    for (const page of PAGES) assert.doesNotMatch(read(out, page), /<form\b[^>]*\saction="(?:https?:)?\/\//, `${page}: no form posts to another site`);
    const form = /<form class="news-form"[^>]*>([\s\S]*?)<\/form>/.exec(read(out, 'index.html'));
    assert.ok(form, 'the form is still on the page');
    const open = form[0].slice(0, form[0].indexOf('>'));
    assert.match(open, /data-preview="off"/);
    assert.doesNotMatch(open, /\bmethod=|\baction=/);
    // the Enter key sends a form whose button is missing or is not a submit button; a disabled submit button stops it
    assert.match(form[1], /<input id="news-email" type="email"[^>]* disabled>/);
    assert.match(form[1], /<button class="plate" type="submit" disabled>/);
    assert.match(form[1], /Preview: sign-up is switched off here\. <a class="text-link" href="https:\/\/hindustantyreagencies\.com\/">Subscribe on the shop\u2019s own site<\/a>\./);
  });

  test('nothing in the copy still points at the root of the address', () => {
    for (const rel of files.filter(f => f.endsWith('.html'))) {
      const stray = [...read(out, rel).matchAll(/\b(?:href|src|action|poster)="(\/(?!\/)[^"]*)"/g)].map(m => m[1]).filter(u => u !== BASE + '/' && !u.startsWith(BASE + '/'));
      assert.deepEqual(stray, [], rel);
    }
    for (const rel of files.filter(f => f.endsWith('.js') && f !== 'js/static-host.js')) {
      const stray = [...read(out, rel).matchAll(/['"`]\/(?:assets|css|js|tyres|compare|privacy|passport|staff|admin|api)(?=[/'"`?#])/g)].map(m => m[0]);
      assert.deepEqual(stray, [], rel);
    }
  });

  test('every file a page asks for exists, spelled exactly as asked (a Linux host tells Logo.png from logo.png)', () => {
    let checked = 0;
    for (const page of PAGES) {
      const html = read(out, page), dir = path.posix.dirname(page);
      for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"|\bsrcset="([^"]+)"/g)) {
        for (let url of (m[1] ? [m[1]] : m[2].split(',').map(s => s.trim().split(/\s+/)[0]))) {
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) continue;   // another site, a phone number, a place on the same page
          url = url.replace(/[?#].*$/, '');
          let rel = url.startsWith(BASE + '/') ? url.slice(BASE.length + 1) : path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, url));
          if (rel === '' || rel.endsWith('/')) rel += 'index.html';
          if (rel.startsWith('api/')) continue;   // answered by the server (or its stand-in), never a file
          // pictures, frames and fonts were not copied in this dry run: they are looked for in the project itself
          const where = /^assets\//.test(rel) ? ROOT : out;
          assert.ok(exact(where, rel), `${page} asks for ${url}, and ${rel} is not there under that exact name`);
          checked++;
        }
      }
    }
    assert.ok(checked > 200, `${checked} addresses checked`);
    for (const rel of ['assets', 'css', 'js'].flatMap(f => walk(ROOT, f + '/'))) assert.equal(rel, rel.toLowerCase(), `${rel}: a served file name with a capital letter works on Windows and breaks on a Linux host`);
  });

  describe('the stand-in for the server', () => {
    const k = readKnowledge(path.join(ROOT, 'config', 'chatbot.json'));
    // the script, run outside a browser with the few things it reaches for
    const load = pathname => {
      const calls = [];
      // the one element the script looks for: the passport's "sign-in is off" panel
      const panel = { attrs: {}, title: { textContent: 'Sign-in opens soon' }, text: { textContent: 'Call the shop and we will read your tyre details out to you.' } };
      panel.setAttribute = (k, v) => { panel.attrs[k] = v; };
      panel.querySelector = sel => (sel === 'h2' ? panel.title : sel === 'p' ? panel.text : null);
      const sandbox = {
        URL, Response, Promise, JSON, String, Set, Math, console,
        Element: class {},
        location: { href: 'https://someone.github.io' + pathname, origin: 'https://someone.github.io', pathname },
        document: { readyState: 'complete', addEventListener() {}, getElementById: id => (id === 'signin-off' && /\/passport\/$/.test(pathname) ? panel : null) },
        fetch: (input, init) => { calls.push(String(input)); return Promise.resolve(new Response('"real"', { status: 200 })); },
      };
      sandbox.window = sandbox;
      vm.runInNewContext(read(out, 'js/static-host.js'), sandbox);
      return { fetch: sandbox.fetch, calls, panel };
    };
    const ask = (page, text) => page.fetch(`${BASE}/api/chat`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', text }] }) }).then(r => r.json());

    test('the chat answers with the very words the server gives when no AI key is set', async () => {
      const page = load(`${BASE}/`);
      for (const q of [...k.quick, 'how much does a tyre cost', 'where is the shop', 'asdf qwer zxcv']) {
        assert.equal((await ask(page, q)).text, localAnswer(k, q), q);
      }
      const cfg = await (await page.fetch(`${BASE}/api/chat/config`)).json();
      assert.deepEqual(cfg.quick, k.quick);
      assert.equal(cfg.ai, false, 'it never claims to be the AI');
      assert.equal(page.calls.length, 0, 'none of it left the page');
    });

    test('Compare gets the owner\'s tyre list, and the passport is told nobody is signed in and sign-in is off', async () => {
      const page = load(`${BASE}/compare/`);
      const want = readTyres(path.join(ROOT, 'config', 'tyres.json'));
      assert.deepEqual(await (await page.fetch(`${BASE}/api/public/tyres`)).json(), want);
      const cfg = await (await page.fetch(`${BASE}/api/public/config`)).json();
      assert.equal(cfg.signIn, 'off');
      assert.equal(cfg.mode, 'preview');
      assert.equal(cfg.demo, undefined, 'no sample numbers and no demo PIN: there is nothing to sign in to');
      assert.deepEqual(await (await page.fetch(`${BASE}/api/me`)).json(), { signedIn: false });
    });

    test('everything else that needs the server is refused in plain words, and nothing typed is sent anywhere', async () => {
      const page = load(`${BASE}/passport/`);
      for (const [url, init] of [[`${BASE}/api/auth/request`, { method: 'POST', body: '{"phone":"9876543210"}' }], [`${BASE}/api/staff/login`, { method: 'POST', body: '{"pin":"246810"}' }], ['/api/admin/overview', undefined], [`${BASE}/api/me/delete`, { method: 'POST', body: '{}' }]]) {
        const res = await page.fetch(url, init);
        assert.equal(res.status, 503, url);
        const body = await res.json();
        assert.equal(body.error.code, 'preview');
        assert.match(body.error.message, /preview/);
      }
      assert.equal(page.calls.length, 0, 'no request for the site\'s own API ever reaches the network');
      // other sites and the site's own files are fetched as usual
      await page.fetch('https://example.com/x');
      await page.fetch(`${BASE}/js/lang/hi.js`);
      assert.equal(page.calls.length, 2);
    });

    test('the passport does not send anyone to the shop\'s phone for records that do not exist', () => {
      const { panel } = load(`${BASE}/passport/`);
      assert.equal(panel.title.textContent, 'Not part of this preview');
      assert.match(panel.text.textContent, /This preview holds no customer records\./);
      assert.doesNotMatch(panel.text.textContent, /call the shop/i);
      assert.equal(panel.attrs.translate, 'no');
      // the page as the shop would run it keeps its own wording
      assert.match(fs.readFileSync(path.join(ROOT, 'passport', 'index.html'), 'utf8'), /Sign-in opens soon/);
    });

    test('it holds what the pages need and nothing more: no facts for the AI, no demo PIN, no sample customers', () => {
      const src = read(out, 'js/static-host.js');
      assert.ok(!src.includes(k.facts[0].slice(0, 40)), 'the notes written for the AI model are not published in the page');
      assert.doesNotMatch(src, /staffPin|246810|samples/);
      assert.match(src, /Written by tools\/build-pages\.js/);
    });
  });

  test('what goes public is the site, not the server: no server code, tests, settings or leftovers', () => {
    const top = new Set(files.map(f => f.split('/')[0]));
    assert.deepEqual([...top].sort(), ['.nojekyll', '404.html', 'THIRD-PARTY-LICENSES.txt', 'admin', 'assets', 'compare', 'css', 'index.html', 'js', 'passport', 'privacy', 'staff', 'tyres'].filter(n => n !== 'assets' || top.has('assets')).sort());
    for (const f of files) assert.doesNotMatch(f, /^(server|test|config|tools|node_modules|data)\/|\.env|^assets\/video|^assets\/seq\/tyre/, f);
  });

  test('an output folder that already holds something is refused: the build deletes nothing', async () => {
    await assert.rejects(build({ out, base: BASE, assets: false }), /not empty/);
    await assert.rejects(build({ out: ROOT, base: BASE }), /project folder/);
  });
});

describe('the repository', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map(l => l.trim());
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');

  test('secrets, the customer database and installed packages are never committed', () => {
    for (const line of ['node_modules/', 'data/', '.env', '.env.*', '!.env.example', '_site/', '*.sqlite', '*.sqlite-*', 'backups/', 'accessibility-audit.md']) assert.ok(ignore.includes(line), `.gitignore lists ${line}`);
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const m of example.matchAll(/^([A-Z0-9_]*(?:KEY|SECRET|PIN|TOKEN|PASSWORD)[A-Z0-9_]*)=(.*)$/gm)) assert.equal(m[2].trim(), '', `${m[1]} is empty in the example`);
  });

  test('the workflow tests before it publishes, on the pinned Node version, with every action at an exact version', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map(m => m[1]);
    assert.ok(uses.length >= 7);
    for (const u of uses) assert.match(u, /^actions\/[a-z-]+@v\d+\.\d+\.\d+$/, `${u} is pinned to an exact version`);
    assert.match(workflow, /node-version-file: \.nvmrc/);
    assert.equal(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(), require('../package.json').engines.node);
    assert.match(workflow, /build:\s*\n\s*needs: test/, 'nothing is built for publishing until the tests pass');
    assert.match(workflow, /deploy:\s*\n\s*needs: build/);
    assert.match(workflow, /tools\/build-pages\.js --out _site --base "\$\{\{ steps\.pages\.outputs\.base_path \}\}"/);
    assert.match(workflow, /^permissions:\s*\n\s*contents: read\s*$/m, 'jobs get no more than read access unless they ask');
  });
});
