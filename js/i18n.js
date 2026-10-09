/* Hindi and Punjabi for the pages a customer uses. The English page is built as before; this layer swaps the
   words it knows, in the page as it loads and in everything the page's own scripts draw later, and swaps them
   back when English is chosen again. Vehicle numbers, names and figures are never touched: only sentences that
   are in the dictionary change. The choice is kept in this browser (localStorage) and nowhere else. */
(function () {
  'use strict';
  const KEY = 'hta_lang';
  const LANGS = { en: { code: 'en-IN', label: 'English' }, hi: { code: 'hi-IN', label: 'हिंदी' }, pa: { code: 'pa-IN', label: 'ਪੰਜਾਬੀ' } };
  const ATTRS = ['aria-label', 'placeholder', 'alt', 'title'];
  const SKIP = 'script, style, code, pre, .vplate, .found-name, .chat-panel, .chat-fab, .chat-nudge, [translate="no"], svg, time, .slip, .lang-bar';
  // headings whose words are split around <em>: translated as one sentence, the emphasis marked with *stars*
  const HEAD = 'h1.display, h2.display';
  const html = document.documentElement;

  let lang = 'en';
  try { lang = localStorage.getItem(KEY) || 'en'; } catch (e) { /* the page stays in English */ }
  if (!LANGS[lang]) lang = 'en';

  let dict = null, patterns = [];
  const EN = new WeakMap();   // text node -> { en, out }; element -> { attr: { en, out } } or, for a heading, { en, out }

  function setDict(map) {
    dict = map;
    patterns = [];
    if (!map) return;
    for (const k of Object.keys(map)) {
      if (!/\{\d\}/.test(k)) continue;
      // a placeholder may be empty (a trailing note that is sometimes nothing), so it matches zero characters too
      const re = new RegExp('^' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d)\\\}/g, '(.*?)') + '$');
      patterns.push({ re, out: map[k], order: [...k.matchAll(/\{(\d)\}/g)].map(m => Number(m[1])), fixed: k.replace(/\{\d\}/g, '').length });
    }
    // the most specific pattern (most fixed text) is tried first, so "{0} days" cannot shadow "Step {0} of {1}"
    patterns.sort((a, b) => b.fixed - a.fixed);
  }
  function translate(s, depth = 0) {
    if (!dict || typeof s !== 'string') return s;
    const t = s.trim();
    if (!t) return s;
    if (Object.prototype.hasOwnProperty.call(dict, t)) return s.replace(t, dict[t]);
    if (depth > 2) return s;
    for (const p of patterns) {
      const m = p.re.exec(t);
      if (!m) continue;
      let out = p.out;
      // what fills a placeholder may itself be a sentence the dictionary knows ("in 3 days")
      p.order.forEach((n, i) => { out = out.split('{' + n + '}').join(translate(m[i + 1], depth + 1)); });
      return s.replace(t, out);
    }
    return s;
  }

  const skip = el => el && el.closest && el.closest(SKIP);
  function textNode(node) {
    const parent = node.parentNode;
    if (!parent || skip(parent) || (parent.closest && parent.closest(HEAD))) return;
    let rec = EN.get(node);
    // text the page's own script changed since we last saw it is new English
    if (!rec || node.data !== rec.out) { rec = { en: node.data, out: node.data }; EN.set(node, rec); }
    const out = dict ? translate(rec.en) : rec.en;
    if (node.data !== out) { rec.out = out; node.data = out; }
  }
  function attrs(el) {
    if (skip(el)) return;
    let recs = EN.get(el);
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      if (!recs || !recs.attrs) EN.set(el, (recs = { ...(recs || {}), attrs: {} }));
      const now = el.getAttribute(a);
      if (!recs.attrs[a] || now !== recs.attrs[a].out) recs.attrs[a] = { en: now, out: now };
      const out = dict ? translate(recs.attrs[a].en) : recs.attrs[a].en;
      if (now !== out) { recs.attrs[a].out = out; el.setAttribute(a, out); }
    }
  }
  // a heading: the whole sentence is looked up; the translation marks the emphasised part between *stars*
  function heading(el) {
    if (skip(el)) return;
    let rec = EN.get(el) || {};
    const now = el.textContent.replace(/\s+/g, ' ').trim();
    if (!rec.head || now !== rec.head.out) {
      // remember the English markup once, so switching back restores the emphasis exactly
      rec.head = { en: now, out: now, nodes: [...el.childNodes].map(n => n.cloneNode(true)) };
      EN.set(el, rec);
    }
    const key = rec.head.en;
    const hit = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
    if (!hit) {
      // not known as a whole: back to the English markup, and each piece is tried on its own
      if (rec.head.out !== rec.head.en) { el.replaceChildren(...rec.head.nodes.map(n => n.cloneNode(true))); rec.head.out = rec.head.en; }
      for (const n of el.childNodes) { if (n.nodeType === 3) pieceNode(n); else if (n.nodeType === 1) for (const t of n.childNodes) if (t.nodeType === 3) pieceNode(t); }
      return;
    }
    const parts = hit.split('*');
    const nodes = parts.map((p, i) => (i % 2 ? Object.assign(document.createElement('em'), { textContent: p }) : document.createTextNode(p))).filter(n => n.textContent !== '');
    el.replaceChildren(...nodes);
    rec.head.out = el.textContent.replace(/\s+/g, ' ').trim();
  }
  function pieceNode(node) {
    let rec = EN.get(node);
    if (!rec || node.data !== rec.out) { rec = { en: node.data, out: node.data }; EN.set(node, rec); }
    const out = dict ? translate(rec.en) : rec.en;
    if (node.data !== out) { rec.out = out; node.data = out; }
  }
  function walk(root) {
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType !== 1 || skip(root)) return;
    if (root.matches(HEAD)) return heading(root);
    attrs(root);
    const it = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = it.nextNode())) {
      if (n.nodeType === 3) textNode(n);
      else if (n !== root) { if (n.matches(HEAD)) heading(n); else attrs(n); }
    }
  }

  /* ---------- the dictionary files: one small script per language, fetched when first chosen ---------- */
  function load(code) {
    if (code === 'en') return Promise.resolve(null);
    if (window.HTA_LANG && window.HTA_LANG[code]) return Promise.resolve(window.HTA_LANG[code]);
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = '/js/lang/' + code + '.js';
      s.onload = () => resolve(window.HTA_LANG && window.HTA_LANG[code] ? window.HTA_LANG[code] : null);
      s.onerror = () => { s.remove(); resolve(null); };   // not cached: the next tap tries again
      document.head.append(s);
    });
  }

  let observer = null;
  function apply() {
    walk(document.body);
    if (observer) observer.takeRecords();   // our own changes are not re-read
  }
  async function use(code, save) {
    if (!LANGS[code]) code = 'en';
    const map = await load(code);
    if (code !== 'en' && !map) {
      // the dictionary did not arrive (offline?): English for now, the saved choice is left alone
      code = 'en';
    } else if (save) { try { localStorage.setItem(KEY, code); } catch (e) { /* remembered for this page only */ } }
    lang = code;
    html.lang = LANGS[code].code;
    html.classList.toggle('lang-hi', code === 'hi');
    html.classList.toggle('lang-pa', code === 'pa');
    setDict(map);
    apply();
    markSwitch();
    document.dispatchEvent(new CustomEvent('hta:lang', { detail: { lang: code } }));
  }

  /* ---------- the switch: built once, its state updated in place so focus stays where it was ---------- */
  function drawSwitch() {
    const bar = document.getElementById('lang-bar');
    if (!bar || bar.childElementCount) return;
    bar.replaceChildren(...Object.entries(LANGS).map(([code, l]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lang-btn';
      b.lang = l.code;
      b.dataset.lang = code;
      b.setAttribute('translate', 'no');
      b.textContent = l.label;
      b.addEventListener('click', () => use(code, true));
      return b;
    }));
    markSwitch();
  }
  function markSwitch() {
    for (const b of document.querySelectorAll('#lang-bar .lang-btn')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  }

  // whatever the page draws later is translated as it appears
  observer = new MutationObserver(records => {
    if (!dict) return;
    for (const r of records) {
      if (r.type === 'characterData') textNode(r.target);
      else if (r.type === 'attributes') attrs(r.target);
      else for (const n of r.addedNodes) walk(n);
    }
    observer.takeRecords();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  window.HTA_I18N = { use, translate: s => translate(s), get lang() { return lang; } };
  drawSwitch();
  if (lang !== 'en') use(lang, false);
})();
