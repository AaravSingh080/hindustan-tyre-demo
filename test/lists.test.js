'use strict';

/* Every list on the site is sorted the way Find my tyres is: the same things in the same order with the same
   names wherever they appear, pictures where a picture helps, the most used first and then A to Z, and every
   entry leading to a real screen. Checked from the files themselves. */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
const home = read('index.html'), tyresPage = read('tyres/index.html'), tyresJs = read('js/tyres.js'), mainJs = read('js/main.js'), css = read('css/styles.css');
const between = (src, from, to) => { const a = src.indexOf(from); assert.ok(a >= 0, `"${from}" is in the page`); const b = src.indexOf(to, a); assert.ok(b > a, `"${to}" closes it`); return src.slice(a, b); };
const hrefs = block => [...block.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map(m => m[1]);
// where a link about a kind of vehicle goes: the step of Find my tyres, or the shop's collection
const kindOf = href => (/^(?:\/?tyres\/)?#\/([a-z]+)$/.exec(href) || /collections\/([a-z-]+)/.exec(href) || [])[1];

const window = {};
new Function('window', read('js/data.js'))(window);
const DATA = window.HTA_DATA;

describe('the kinds of vehicle', () => {
  // the first screen of Find my tyres is the model: its order is the order everywhere
  const model = [...between(tyresPage, '<ul class="tiles" id="tiles">', '</ul>').matchAll(/<a class="tile[^"]*" href="[^"]*collections\/([a-z-]+)[^"]*"(?: data-go="#\/([a-z]+)")?/g)].map(m => m[2] || m[1]);
  const lists = {
    'the header menu': hrefs(between(home, '<ul class="vt-grid" aria-labelledby="menu-vehicle-label">', '</ul>')).map(kindOf).filter(k => k),
    'the phone menu': hrefs(between(home, '<ul class="vt-grid" aria-labelledby="sheet-drive">', '</ul>')).map(kindOf),
    'the footer': hrefs(between(home, '<h2 id="foot-cats"', '</ul>')).map(kindOf),
  };

  test('Find my tyres asks about seven kinds, and every other list has the same seven in the same order', () => {
    assert.deepEqual(model, ['car', 'scooter', 'motorcycle', 'tractor', 'truck', 'erickshaw', 'alloy-wheels']);
    for (const [name, list] of Object.entries(lists)) assert.deepEqual(list, model, name);
  });

  test('the picture cards on the home page keep that order too, with the car and the SUV as two pictures of the one first step', () => {
    const cards = hrefs(between(home, '<ul class="cats-list">', '</ul>')).map(kindOf);
    assert.deepEqual(cards, ['car', 'car', ...model.slice(1)]);
  });

  test('a tile shows the same picture and the same name in the header menu, the phone menu and Find my tyres', () => {
    const tiles = (block, re) => [...block.matchAll(re)].map(m => [m[1].replace(/^\//, ''), m[2].replace(/\s*<svg[\s\S]*$/, '').trim()]);
    const model = tiles(between(tyresPage, '<ul class="tiles" id="tiles">', '</ul>'), /<img src="([^"]+)"[^>]*><\/span><span class="tile-name">([\s\S]*?)<\/span>/g);
    assert.equal(model.length, 7);
    for (const from of ['<ul class="vt-grid" aria-labelledby="menu-vehicle-label">', '<ul class="vt-grid" aria-labelledby="sheet-drive">']) {
      const here = tiles(between(home, from, '</ul>'), /<img src="([^"]+)"[^>]*><\/span><span class="vt-name">([\s\S]*?)<\/span>/g);
      assert.deepEqual(here, model, from);
    }
    for (const [src] of model) assert.ok(exists(src), src);
  });

  test('every link into Find my tyres names a step the page really has', () => {
    const types = [...tyresJs.matchAll(/^    ([a-z]+): \{ name: '/gm)].map(m => m[1]);
    assert.deepEqual(types, ['car', 'scooter', 'motorcycle', 'truck', 'tractor', 'erickshaw']);
    const steps = new Set(['', 'car', 'car/size', 'brand', ...types]);
    const links = [...home.matchAll(/href="tyres\/(?:#\/([a-z/]*))?"/g)].map(m => m[1] || '');
    assert.ok(links.length >= 30, `${links.length} links into Find my tyres`);
    for (const step of links) assert.ok(steps.has(step), `tyres/#/${step} is not a step`);
    const bare = [...home.matchAll(/href="([^"]*collections\/(?!alloy-wheels)[^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(bare, [], 'nothing on the home page drops a visitor into a bare product list, except alloy wheels, which have no sizes to ask about');
    for (const view of ['brand', 'brandtype']) assert.match(tyresPage, new RegExp(`data-view="${view}"`));
  });

  test('a list that used to scroll sideways on a phone is a grid there now, and with motion reduced', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 899px) {'));
    assert.match(phone, /\.cats-list, \.rm \.cats-list, html:not\(\.js\) \.cats-list \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    assert.match(css, /\.rm \.cats-list, html:not\(\.js\) \.cats-list \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
    assert.doesNotMatch(css, /\.cats-list[^{]*\{[^}]*overflow-x: auto/);
  });
});

describe('menus say what they open', () => {
  test('every row of the phone menu has a name and a few plain words under it', () => {
    const sheet = between(home, '<dialog class="sheet" id="menu"', '</dialog>');
    const rows = [...sheet.matchAll(/<a class="row" href="([^"]+)">[\s\S]*?<b>([^<]+)<\/b><small>([^<]+)<\/small>/g)];
    assert.equal(rows.length, 7);
    for (const [, href, name, about] of rows) {
      assert.ok(name.length >= 4 && about.split(' ').length >= 3, `${name}: ${about}`);
      assert.doesNotMatch(about, /[–—]/, 'no dashes in page copy');
      if (!/^https?:|^#/.test(href)) assert.ok(exists(href.replace(/#.*$/, '') + 'index.html'), href);
    }
    assert.match(sheet, /<b>Tyre Passport<\/b><small>Your bill, warranty and service record<\/small>/, 'the passport is explained where it is offered');
    assert.match(sheet, /href="compare\/"/);
  });

  test('the footer lists are complete, in the same words, and the policies lead with the one people ask about', () => {
    const foot = between(home, '<div class="wrap foot-grid">', '<div class="wrap foot-base">');
    assert.equal((foot.match(/<nav /g) || []).length, 3);
    const policies = [...between(foot, '<h2 id="foot-pol"', '</ul>').matchAll(/<a [^>]*>([^<]+)</g)].map(m => m[1]);
    assert.equal(policies[0], 'Tyre warranty');
    assert.equal(policies.length, 6);
    assert.match(foot, /href="passport\/">Tyre Passport <small>/);
  });
});

describe('the finder on the home page', () => {
  test('lists the most chosen companies first and the rest A to Z, spelled as Find my tyres spells them', () => {
    const top = /const TOP_MAKES = (\[[^\]]+\]);/;
    assert.ok(top.test(mainJs) && top.test(tyresJs));
    assert.equal(top.exec(mainJs)[1], top.exec(tyresJs)[1], 'both pages agree on the most chosen companies');
    for (const re of [/const MAKE_LABELS = (\{[^}]+\});/, /const ACRONYMS = (\[[^\]]+\]);/]) assert.equal(re.exec(mainJs)[1], re.exec(tyresJs)[1].replace(/, 'range\/rover'[\s\S]*$/, ''), 'both pages spell names the same way');
    assert.match(mainJs, /optgroup\('Most chosen', topMakes\)/);
    assert.match(mainJs, /'All other companies, A to Z'/);
    assert.match(mainJs, /\.sort\(byLabel\)\.forEach\(m => modelSel\.appendChild/, 'models are in A to Z order too');
  });
});

describe('tyre brands', () => {
  test('every brand offered has its logo, safe words to search the shop with, and only kinds of vehicle the page knows', () => {
    assert.ok(Array.isArray(DATA.brands) && DATA.brands.length >= 8, 'the brand list is in js/data.js');
    const kinds = Object.keys(DATA.brandTypeTags);
    assert.deepEqual(kinds.sort(), ['car', 'erickshaw', 'motorcycle', 'scooter', 'tractor', 'truck']);
    const ids = new Set();
    for (const b of DATA.brands) {
      assert.match(b.id, /^[a-z]+$/);
      assert.ok(!ids.has(b.id), `${b.id} is listed once`);
      ids.add(b.id);
      assert.ok(exists(`assets/img/brands/${b.id}.webp`), `${b.name} has a logo`);
      assert.ok(b.words.length && b.words.every(w => /^[a-z0-9]+$/.test(w)), `${b.name}: search words are plain`);
      assert.ok(b.types.length && b.types.every(t => kinds.includes(t)), `${b.name}: ${b.types}`);
      assert.ok(Number.isInteger(b.n) && b.n > 0);
    }
    // the brands on the home page's moving strip and the brands in the list are the same brands
    const strip = [...between(home, '<ul class="marquee-track">', '</ul>').matchAll(/brands\/([a-z]+)\.webp/g)].map(m => m[1]).sort();
    assert.deepEqual([...ids].sort(), strip);
  });

  test('the brand screens sort the biggest ranges first, then A to Z, and hand over to a search the shop understands', () => {
    assert.match(tyresJs, /\[\.\.\.BRANDS\]\.sort\(\(a, b\) => b\.n - a\.n\)\.slice\(0, TOP_BRANDS\)/);
    assert.match(tyresJs, /rest = BRANDS\.filter\(b => !top\.includes\(b\)\)\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\)/);
    assert.match(tyresJs, /'\/search\?type=product&q=' \+ encodeURIComponent\(/);
    assert.match(tyresPage, /Biggest range at the shop[\s\S]*All other brands, A to Z/);
    assert.match(home, /<a class="plate plate-mini" href="tyres\/#\/brand">/, 'the brands section on the home page leads to the list');
    assert.doesNotMatch(tyresJs, /innerHTML|insertAdjacentHTML/);
  });
});

describe('the chat', () => {
  const chat = read('js/chat.js'), chatCss = read('css/chat.css');

  test('the common questions sit above the typing bar, and each message carries its time in hours and minutes', () => {
    const panel = /const panel = h\('section\.chat-panel'[\s\S]*?\n {4}h\('div\.chat-body', log, latest\), quick, form\);/;
    assert.match(chat, panel, 'the panel is built as: head, conversation, questions, typing bar');
    assert.match(chat, /String\(d\.getHours\(\)\)\.padStart\(2, '0'\) \+ ':' \+ String\(d\.getMinutes\(\)\)\.padStart\(2, '0'\)/);
    assert.match(chat, /h\('time\.ch-time', \{ datetime: new Date\(m\.at\)\.toISOString\(\) \}, hhmm\(m\.at\)\)/);
    assert.match(chatCss, /\.ch-ai \{ align-self: flex-start;/, 'the assistant speaks from the left');
    assert.match(chatCss, /\.ch-me \{ align-self: flex-end;/, 'the visitor from the right');
  });

  test('all the questions show before the first one is asked, then fold to one row', () => {
    assert.match(chat, /setQuick\(state\.quick === null \? !asked\(\) : state\.quick\)/);
    assert.match(chatCss, /\.chat-quick\.is-open \.chat-quick-list \{ flex-direction: column;/);
    assert.match(chatCss, /\.chat-quick\.is-open \.ch-q \{ width: 100%; min-height: 44px;/);
  });

  test('an answer that names a page or the number carries a button for it, built without markup', () => {
    for (const label of ['Open Find my tyres', 'Open the tyre passport', 'WhatsApp the shop', 'Call the shop']) assert.ok(chat.includes(`'${label}'`), label);
    assert.match(chat, /if \(acts\.length < 3 &&/, 'never more than three');
    assert.match(chatCss, /\.ch-act \{[^}]*min-height: 44px;/);
    assert.doesNotMatch(chat, /innerHTML|outerHTML|insertAdjacentHTML/);
  });

  test('nothing is lost by accident: starting again can be taken back, and a half-typed message survives the next page', () => {
    assert.match(chat, /'Bring it back'/);
    assert.match(chat, /function undo\(\) \{\s*if \(!kept \|\| sending\) return;/);
    assert.match(chat, /state\.draft = input\.value; save\(\);/);
    assert.match(chat, /if \(state\.draft\) \{ input\.value = state\.draft; \}/);
  });

  test('on a phone the panel is a dialog that follows the keyboard, and the count on the roundel is honest', () => {
    assert.match(chat, /panel\.setAttribute\('aria-modal', 'true'\)/);
    assert.match(chat, /window\.visualViewport/);
    assert.match(chatCss, /height: var\(--vvh, 100dvh\)/);
    assert.match(chat, /if \(!opened\) \{ state\.unread = Math\.min\(9, state\.unread \+ 1\);/, 'only answers that arrived while the panel was shut are counted');
    assert.match(chatCss, /\.chat-fab \[hidden\], \.chat-panel \[hidden\] \{ display: none !important; \}/);
  });
});
