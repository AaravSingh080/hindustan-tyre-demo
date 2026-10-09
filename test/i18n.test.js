'use strict';

/* Hindi and Punjabi on the customer pages: every readable English string has a translation, placeholders and
   proper names survive, nothing is written with a dash, and the pages load the switch, the dictionaries and
   the fonts. */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/app');
const { extract, dictionary } = require('../tools/i18n-strings');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-i18n-'));
const LANGS = { hi: { name: 'Hindi', range: /[ऀ-ॿ]/ }, pa: { name: 'Punjabi', range: /[਀-੿]/ } };
// names and codes that must come through untouched (WhatsApp and Ludhiana may be written in the script itself)
const KEEP = ['MRF', 'CEAT', 'Apollo', 'Hindustan Tyre', 'STOP', 'DELETE', '185/65 R15'];
const placeholders = s => [...s.matchAll(/\{(\d)\}/g)].map(m => m[1]).sort().join(',');

describe('the dictionaries', () => {
  const strings = extract();
  test('the extractor finds the words a customer reads, and nothing that is code', () => {
    const all = strings.map(x => x.s);
    for (const s of ['What do you drive?', 'Found it.', 'Skip to content', 'Not sure?', 'Send my code', 'Your tyres, on record', 'Step {0} of {1}']) assert.ok(all.includes(s), `"${s}" should be in the list`);
    for (const s of all) {
      assert.doesNotMatch(s, /^\/api|^#|^\.|^data-|^aria-/, `code in the list: ${s}`);
      assert.ok(s.length <= 400, `too long to be a label: ${s.slice(0, 60)}`);
    }
    assert.ok(all.length >= 200 && all.length <= 400, `${all.length} strings`);
  });

  for (const [code, l] of Object.entries(LANGS)) {
    test(`${l.name}: every string is translated, in ${l.name} letters, with placeholders and names kept`, () => {
      const d = dictionary(code);
      assert.ok(d, `js/lang/${code}.js defines window.HTA_LANG.${code}`);
      const missing = strings.filter(x => typeof d[x.s] !== 'string' || !d[x.s].trim());
      assert.deepEqual(missing.map(x => x.s), [], `${missing.length} strings have no ${l.name}`);
      let inScript = 0;
      for (const { s } of strings) {
        const v = d[s];
        assert.equal(placeholders(v), placeholders(s), `placeholders differ for "${s}": "${v}"`);
        assert.doesNotMatch(v, /[–—]/, `dash in "${v}"`);
        assert.doesNotMatch(v, /<[a-z/]/i, `markup in "${v}"`);
        if (l.range.test(v)) inScript++;
        for (const k of KEEP) if (s.includes(k)) assert.ok(v.toLowerCase().includes(k.toLowerCase()), `"${k}" dropped from "${s}" -> "${v}"`);
      }
      assert.ok(inScript / strings.length > 0.9, `${inScript} of ${strings.length} values use ${l.name} letters`);
      // labels stay short enough for a plate
      for (const { s } of strings) if (s.split(' ').length <= 3 && !/[.?!]/.test(s)) assert.ok(d[s].length <= 36, `too long for a plate: "${s}" -> "${d[s]}" (${d[s].length})`);
    });
  }
});

describe('the pages', () => {
  let app, server, url;
  before(async () => {
    app = createApp({ env: { DATA_DIR: TMP }, log: () => {} });
    server = http.createServer(app.handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://localhost:${server.address().port}`;
  });
  after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); app.close(); });
  const get = async p => { const r = await fetch(url + p); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };

  test('Find my tyres and the passport carry the switch and the layer; the staff pages do not', async () => {
    for (const p of ['/tyres/', '/passport/']) {
      const html = (await get(p)).text;
      assert.ok(html.includes('id="lang-bar"'), p + ' has the language bar');
      assert.ok(html.includes('/js/i18n.js') && html.includes('/css/lang.css'), p + ' loads the layer');
      assert.ok(html.indexOf('/js/app-kit.js') < html.indexOf('/js/i18n.js'), p + ' loads the kit first');
    }
    for (const p of ['/staff/', '/admin/']) assert.ok(!(await get(p)).text.includes('/js/i18n.js'), p + ' stays in English');
  });

  test('the dictionaries and the fonts are served', async () => {
    for (const code of Object.keys(LANGS)) {
      const r = await get(`/js/lang/${code}.js`);
      assert.equal(r.status, 200);
      assert.match(r.type, /javascript/);
      assert.ok(r.text.includes(`window.HTA_LANG.${code} =`));
    }
    const css = (await get('/css/lang.css')).text;
    for (const m of css.matchAll(/url\("\.\.\/(assets\/fonts\/[^"]+)"\)/g)) assert.equal((await get('/' + m[1])).status, 200, m[1]);
    assert.ok(css.includes('unicode-range: U+0900-097F') && css.includes('unicode-range: U+0A00-0A7F'), 'Indic fonts load only for Indic letters');
  });

  test('the layer never touches vehicle numbers, the chat, or anything marked translate="no"', () => {
    const js = fs.readFileSync(path.join(ROOT, 'js', 'i18n.js'), 'utf8');
    for (const sel of ['.vplate', '.chat-panel', '[translate="no"]', 'script', 'time']) assert.ok(js.includes(sel), `${sel} is skipped`);
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/);
    assert.match(js, /localStorage/, 'the choice is kept in the browser only');
    assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|sendBeacon/, 'the layer sends nothing anywhere');
  });
});
