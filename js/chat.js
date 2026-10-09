/* The chat assistant on every page: a roundel in the bottom right corner and a panel that grows out of it.
   The visitor speaks from the right, the assistant from the left, each message with its time. The shop's
   common questions sit above the typing bar: all of them at once before the first question, one row after
   it. An answer that names a page or the shop's number carries a button for it, so nobody has to find a link
   in a sentence. Everything is built from text nodes, never markup, so nothing typed or answered can become
   code. The conversation lives in this tab only (sessionStorage) and is sent to the server with each
   question; the server keeps none of it. */
(function () {
  'use strict';
  if (!window.fetch || !document.body || !('replaceChildren' in document.body)) return;

  const SVG = 'http://www.w3.org/2000/svg';
  const KEY = 'hta_chat';
  const MAX_TURNS = 12, USER_MAX = 600, REPLY_MAX = 1200;
  const WA = '918303400005';
  const STORE = 'https://hindustantyreagencies.com';
  const FALLBACK = {
    name: 'Hindustan Tyre assistant',
    greeting: 'Hello. Ask me about tyres, sizes, fitting, warranty, delivery or your tyre passport. For prices and stock, WhatsApp us and a person replies.',
    quick: ['What tyre size do I need?', 'Do you fit tyres at the shop?', 'Is the warranty genuine?', 'When should I replace my tyres?', 'What is the tyre passport?', 'Do you deliver outside Ludhiana?'],
    note: 'Answers from the shop’s own information. For prices and stock, WhatsApp a person.',
    ai: false,
    whatsapp: WA,
  };
  // Phosphor regular icons, drawn here so the widget needs nothing from the page
  const PATHS = {
    headset: 'M201.89,54.66A103.43,103.43,0,0,0,128.79,24H128A104,104,0,0,0,24,128v56a24,24,0,0,0,24,24H64a24,24,0,0,0,24-24V144a24,24,0,0,0-24-24H40.36A88.12,88.12,0,0,1,190.54,65.93,87.39,87.39,0,0,1,215.65,120H192a24,24,0,0,0-24,24v40a24,24,0,0,0,24,24h24a24,24,0,0,1-24,24H136a8,8,0,0,0,0,16h56a40,40,0,0,0,40-40V128A103.41,103.41,0,0,0,201.89,54.66ZM64,136a8,8,0,0,1,8,8v40a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V136Zm128,56a8,8,0,0,1-8-8V144a8,8,0,0,1,8-8h24v56Z',
    x: 'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z',
    send: 'M227.32,28.68a16,16,0,0,0-15.66-4.08l-.15,0L19.57,82.84a16,16,0,0,0-2.49,29.8L102,154l41.3,84.87A15.86,15.86,0,0,0,157.74,248q.69,0,1.38-.06a15.88,15.88,0,0,0,14-11.51l58.2-191.94c0-.05,0-.1,0-.15A16,16,0,0,0,227.32,28.68ZM157.83,231.85l-.05.14,0-.07-40.06-82.3,48-48a8,8,0,0,0-11.31-11.31l-48,48L24.08,98.25l-.07,0,.14,0L216,40Z',
    'arrow-counter-clockwise': 'M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z',
    'arrow-down': 'M205.66,149.66l-72,72a8,8,0,0,1-11.32,0l-72-72a8,8,0,0,1,11.32-11.32L120,196.69V40a8,8,0,0,1,16,0V196.69l58.34-58.35a8,8,0,0,1,11.32,11.32Z',
    'arrow-right': 'M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z',
    'phone': 'M222.37,158.46l-47.11-21.11-.13-.06a16,16,0,0,0-15.17,1.4,8.12,8.12,0,0,0-.75.56L134.87,160c-15.42-7.49-31.34-23.29-38.83-38.51l20.78-24.71c.2-.25.39-.5.57-.77a16,16,0,0,0,1.32-15.06l0-.12L97.54,33.64a16,16,0,0,0-16.62-9.52A56.26,56.26,0,0,0,32,80c0,79.4,64.6,144,144,144a56.26,56.26,0,0,0,55.88-48.92A16,16,0,0,0,222.37,158.46ZM176,208A128.14,128.14,0,0,1,48,80,40.2,40.2,0,0,1,82.87,40a.61.61,0,0,0,0,.12l21,47L83.2,111.86a6.13,6.13,0,0,0-.57.77,16,16,0,0,0-1,15.7c9.06,18.53,27.73,37.06,46.46,46.11a16,16,0,0,0,15.75-1.14,8.44,8.44,0,0,0,.74-.56L168.89,152l47,21.05h0s.08,0,.11,0A40.21,40.21,0,0,1,176,208Z',
    'whatsapp-logo': 'M187.58,144.84l-32-16a8,8,0,0,0-8,.5l-14.69,9.8a40.55,40.55,0,0,1-16-16l9.8-14.69a8,8,0,0,0,.5-8l-16-32A8,8,0,0,0,104,64a40,40,0,0,0-40,40,88.1,88.1,0,0,0,88,88,40,40,0,0,0,40-40A8,8,0,0,0,187.58,144.84ZM152,176a72.08,72.08,0,0,1-72-72A24,24,0,0,1,99.29,80.46l11.48,23L101,118a8,8,0,0,0-.73,7.51,56.47,56.47,0,0,0,30.15,30.15A8,8,0,0,0,138,155l14.61-9.74,23,11.48A24,24,0,0,1,152,176ZM128,24A104,104,0,0,0,36.18,176.88L24.83,210.93a16,16,0,0,0,20.24,20.24l34.05-11.35A104,104,0,1,0,128,24Zm0,192a87.87,87.87,0,0,1-44.06-11.81,8,8,0,0,0-6.54-.67L40,216,52.47,178.6a8,8,0,0,0-.66-6.54A88,88,0,1,1,128,216Z',
    'magnifying-glass': 'M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z',
    'caret-up': 'M213.66,165.66a8,8,0,0,1-11.32,0L128,91.31,53.66,165.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,213.66,165.66Z',
    'list-bullets': 'M80,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H88A8,8,0,0,1,80,64Zm136,56H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,64H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16ZM44,52A12,12,0,1,0,56,64,12,12,0,0,0,44,52Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,116Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,180Z',
  };

  const $ = (s, r = document) => r.querySelector(s);
  const h = (spec, ...rest) => {
    const [tag, ...classes] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const item of rest.flat()) {
      if (item == null || item === false) continue;
      if (item instanceof Node) el.append(item);
      else if (typeof item === 'object') {
        for (const [k, v] of Object.entries(item)) {
          if (v == null || v === false) continue;
          if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
          else el.setAttribute(k, v === true ? '' : String(v));
        }
      } else el.append(String(item));
    }
    return el;
  };
  const icon = (name, cls) => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 256 256');
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', PATHS[name] || '');
    p.setAttribute('fill', 'currentColor');
    svg.append(p);
    return svg;
  };
  const root = document.documentElement;
  const rm = () => root.classList.contains('rm');
  const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const stat = name => { try { if (typeof window.HTA_STAT === 'function') window.HTA_STAT(name); } catch (e) { /* counting is never allowed to break the chat */ } };
  // on a phone the panel is the whole screen and behaves as a dialog; on a wide screen it floats beside the page
  const phone = () => innerWidth <= 480;
  const finePointer = window.matchMedia ? matchMedia('(hover: hover) and (pointer: fine)') : { matches: false };

  /* ---------- what this tab remembers ---------- */
  let state = { msgs: [], open: false, nudged: false, draft: '', unread: 0, quick: null };
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved && Array.isArray(saved.msgs)) {
      state = {
        msgs: saved.msgs.filter(m => m && typeof m.t === 'string' && (m.r === 'ai' || m.r === 'me' || m.r === 'sys') && Number.isFinite(m.at)).slice(-40),
        open: !!saved.open, nudged: !!saved.nudged,
        draft: typeof saved.draft === 'string' ? saved.draft.slice(0, USER_MAX) : '',
        unread: Number.isInteger(saved.unread) && saved.unread > 0 ? Math.min(saved.unread, 9) : 0,
        quick: saved.quick === true || saved.quick === false ? saved.quick : null,
      };
    }
  } catch (e) { /* a fresh start */ }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode: the chat still works, it just forgets on the next page */ } };
  const asked = () => state.msgs.some(m => m.r === 'me');

  /* ---------- settings from the server, fetched quietly after the page has settled ---------- */
  let cfg = null, cfgPromise = null;
  const loadConfig = () => cfgPromise || (cfgPromise = fetch('/api/chat/config', { headers: { 'x-hta': '1' }, credentials: 'same-origin', cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(c => { cfg = c && Array.isArray(c.quick) && typeof c.greeting === 'string' ? c : { ...FALLBACK, off: !c }; return cfg; }));
  const waDigits = () => String((cfg && cfg.whatsapp) || WA).replace(/\D/g, '');
  const prettyWa = () => { const d = waDigits().slice(-10); return d.slice(0, 5) + ' ' + d.slice(5); };

  /* ---------- the pieces ---------- */
  const badge = h('span.chat-badge', { 'aria-hidden': 'true', hidden: true });
  const fab = h('button.chat-fab', { type: 'button', 'aria-label': 'Chat with the shop assistant', 'aria-expanded': 'false', 'aria-controls': 'chat-panel' }, icon('headset', 'i-head'), icon('x', 'i-x'), badge);
  const nudge = h('button.chat-nudge', { type: 'button', tabindex: '-1', 'aria-hidden': 'true' }, 'Ask about tyres');
  const title = h('h2.chat-title', { id: 'chat-title', tabindex: '-1' }, FALLBACK.name);
  const sub = h('p.chat-sub', 'Automatic answers');
  const restartBtn = h('button.roundel.chat-restart', { type: 'button', 'aria-label': 'Start the chat again', hidden: true }, icon('arrow-counter-clockwise'));
  const waLink = h('a.roundel.chat-wa', { href: 'https://wa.me/' + WA, target: '_blank', rel: 'noopener', 'aria-label': 'WhatsApp a person at the shop' }, icon('whatsapp-logo'));
  const closeBtn = h('button.roundel.chat-close', { type: 'button', 'aria-label': 'Close the chat' }, icon('x'));
  const note = h('p.chat-note', FALLBACK.note);
  const undoBar = h('p.chat-undo', { hidden: true }, 'Chat cleared. ', h('button.ch-link', { type: 'button', onclick: () => undo() }, 'Bring it back'));
  const list = h('ol.chat-msgs');
  const log = h('div.chat-log', { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0', 'aria-label': 'Conversation' }, note, undoBar, list);
  const latest = h('button.roundel.chat-latest', { type: 'button', 'aria-label': 'Go to the latest message', hidden: true }, icon('arrow-down'));
  const quickLabel = h('span.chat-quick-label', { id: 'chat-quick-label' }, 'Tap a question');
  const lessBtn = h('button.ch-chip', { type: 'button', onclick: () => setQuick(false, true) }, 'Show less', icon('caret-up', 'i-flip'));
  const allBtn = h('button.ch-chip.ch-all', { type: 'button', 'aria-label': 'Show all the common questions', onclick: () => setQuick(true, true) }, icon('list-bullets'), 'All');
  const quickList = h('div.chat-quick-list');
  const quick = h('div.chat-quick', { role: 'group', 'aria-labelledby': 'chat-quick-label' }, h('div.chat-quick-head', quickLabel, lessBtn), quickList);
  const input = h('textarea.chat-input', { id: 'chat-input', rows: '1', placeholder: 'Type your question', maxlength: String(USER_MAX), enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'sentences', 'aria-describedby': 'chat-count' });
  const sendBtn = h('button.roundel.chat-send', { type: 'submit', 'aria-label': 'Send', disabled: true }, icon('send'));
  const count = h('p.chat-count', { id: 'chat-count', hidden: true });
  const form = h('form.chat-form', { novalidate: true }, h('label.chat-vh', { for: 'chat-input' }, 'Your message'), input, sendBtn, count);
  const panel = h('section.chat-panel', { id: 'chat-panel', role: 'dialog', 'aria-labelledby': 'chat-title' },
    h('header.chat-head', h('span.chat-mark', { 'aria-hidden': 'true' }, icon('headset')), h('div.chat-who', title, sub), restartBtn, waLink, closeBtn),
    h('div.chat-body', log, latest), quick, form);
  document.body.append(fab, nudge, panel);

  /* ---------- drawing messages ---------- */
  // plain text with the links in it made tappable: the site's own pages, web addresses and the shop's WhatsApp number
  const LINK_RE = /(https?:\/\/[^\s<>"')\]]+[^\s<>"').,;:!?\]]|(?:^|[\s(])\/(?:tyres|passport|privacy|staff)\/|(?:^|[\s(])(?:www\.)?hindustantyreagencies\.com(?:\/[^\s<>"')\]]*[^\s<>"').,;:!?\]])?|\+?91\s?\d{5}\s\d{5}|\b\d{5}\s\d{5}\b)/g;
  function linkify(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(LINK_RE)) {
      let s = m[0], i = m.index;
      // a match may begin with the space or bracket before the link: that stays plain text
      if (/^[\s(]/.test(s)) { out.push(text.slice(last, i + 1)); s = s.slice(1); i += 1; }
      else if (i > last) out.push(text.slice(last, i));
      let href = null, external = true;
      if (s.startsWith('/')) { href = s; external = false; }
      else if (/^https?:/.test(s)) href = s;
      else if (/hindustantyreagencies\.com/.test(s)) href = 'https://' + s.replace(/^www\./, '');
      else { const digits = s.replace(/\D/g, '').slice(-10); if (waDigits().endsWith(digits)) href = 'https://wa.me/' + waDigits(); }
      if (href) out.push(h('a', { href, target: external ? '_blank' : null, rel: external ? 'noopener' : null }, s));
      else out.push(s);
      last = i + s.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  // an answer written as steps or points is drawn as a list; everything else keeps its own line breaks
  const ITEM_RE = /^\s*(?:[-*•]|(\d{1,2})[.)])\s+(\S.*)$/;
  function rich(text) {
    const out = [];
    let lines = [], items = null, numbered = false;
    const flushText = () => { if (lines.length) { out.push(h('span.ch-text', linkify(lines.join('\n').trim()))); lines = []; } };
    const flushList = () => { if (items) { out.push(h((numbered ? 'ol' : 'ul') + '.ch-list', items)); items = null; } };
    for (const line of text.split('\n')) {
      const m = ITEM_RE.exec(line);
      if (m) {
        flushText();
        if (items && numbered !== !!m[1]) flushList();
        numbered = !!m[1];
        (items = items || []).push(h('li', linkify(m[2].trim())));
      } else { flushList(); if (line.trim() || lines.length) lines.push(line); }
    }
    flushText();
    flushList();
    return out;
  }
  // the buttons under an answer: one for each place the answer points to, at most three
  function actionsFor(text) {
    const acts = [];
    const add = (label, href, name, external) => { if (acts.length < 3 && !acts.some(a => a.href === href)) acts.push({ label, href, name, external }); };
    if (/(?:^|[\s(])\/tyres\//.test(text)) add('Open Find my tyres', '/tyres/', 'magnifying-glass');
    if (/(?:^|[\s(])\/passport\//.test(text)) add('Open the tyre passport', '/passport/', 'arrow-right');
    if (/tyre-warranty-policy/.test(text)) add('Read the warranty policy', STORE + '/pages/tyre-warranty-policy', 'arrow-right', true);
    else if (/hindustantyreagencies\.com/.test(text)) add('Open the online store', STORE, 'arrow-right', true);
    const hasNumber = [...text.matchAll(/\+?91\s?\d{5}\s\d{5}|\b\d{5}\s\d{5}\b/g)].some(m => waDigits().endsWith(m[0].replace(/\D/g, '').slice(-10)));
    if (/whatsapp/i.test(text)) add('WhatsApp the shop', 'https://wa.me/' + waDigits(), 'whatsapp-logo', true);
    if (hasNumber && /\bcall\b/i.test(text)) add('Call the shop', 'tel:+' + waDigits(), 'phone');
    return acts;
  }

  function row(m, fresh) {
    const mine = m.r === 'me';
    const li = h('li.ch-msg' + (mine ? '.ch-me' : '.ch-ai') + (m.bad ? '.is-bad' : '') + (fresh ? '.is-new' : ''));
    const bubble = h('div.ch-bubble', mine ? m.t : rich(m.t));
    li.append(bubble);
    if (m.bad) li.append(h('div.ch-acts', h('button.ch-act', { type: 'button', onclick: () => retry(m) }, icon('arrow-counter-clockwise'), 'Try again'),
      h('a.ch-act', { href: 'https://wa.me/' + waDigits(), target: '_blank', rel: 'noopener' }, icon('whatsapp-logo'), 'WhatsApp the shop')));
    else if (!mine) {
      const acts = actionsFor(m.t);
      if (acts.length) li.append(h('div.ch-acts', acts.map(a => h('a.ch-act', { href: a.href, target: a.external ? '_blank' : null, rel: a.external ? 'noopener' : null }, icon(a.name), a.label))));
    }
    li.append(h('time.ch-time', { datetime: new Date(m.at).toISOString() }, hhmm(m.at)));
    return li;
  }
  let typing = null;
  const nearEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  // following: the reader is at the newest message and wants to stay there. Only their own scrolling ends
  // that; the log's own glide to the end (which may still be under way when the next message lands) does not.
  let following = true, handAt = 0;
  const toBottom = () => { following = true; log.scrollTop = log.scrollHeight; latest.hidden = true; latest.classList.remove('is-new'); };
  function draw() {
    list.replaceChildren(...state.msgs.map(m => row(m)));
    if (typing) list.append(typing);
    restartBtn.hidden = !asked();
    // a conversation is read from its newest message; the welcome is read from its first line
    if (asked()) toBottom(); else { following = true; log.scrollTop = 0; latest.hidden = true; }
  }
  function add(m) {
    const stay = m.r === 'me' || following || nearEnd();
    state.msgs.push(m);
    if (state.msgs.length > 40) state.msgs = state.msgs.slice(-40);
    save();
    const el = row(m, true);
    if (typing) typing.before(el); else list.append(el);
    restartBtn.hidden = !asked();
    // someone reading further up is left where they are, and told there is something new
    if (stay) toBottom(); else { latest.hidden = false; latest.classList.add('is-new'); }
    return el;
  }
  function showTyping(on) {
    if (on && !typing) { typing = h('li.ch-msg.ch-ai.ch-typing.is-new', { 'aria-label': 'The assistant is typing' }, h('div.ch-bubble', h('span.ch-dots', h('i'), h('i'), h('i')))); list.append(typing); toBottom(); }
    if (!on && typing) { typing.remove(); typing = null; }
  }
  for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) log.addEventListener(type, () => { handAt = Date.now(); }, { passive: true });
  log.addEventListener('scroll', () => {
    if (nearEnd()) { following = true; latest.hidden = true; latest.classList.remove('is-new'); }
    else if (Date.now() - handAt < 1500) { following = false; if (list.children.length > 2) latest.hidden = false; }
  }, { passive: true });
  latest.addEventListener('click', () => { toBottom(); log.focus({ preventScroll: true }); });

  /* ---------- the common questions ---------- */
  // all of them, stacked, until the first question has been asked; after that one row, so the answers have the room
  function setQuick(open, byHand) {
    if (byHand) { state.quick = open; save(); }
    quick.classList.toggle('is-open', open);
    quickLabel.textContent = asked() ? 'Common questions' : 'Tap a question';
    lessBtn.hidden = !asked();
    quickList.scrollLeft = 0;
    quickEnd();
    if (opened && following && asked()) toBottom();
    if (byHand) (open ? lessBtn : allBtn).focus({ preventScroll: true });
  }
  const quickEnd = () => quick.classList.toggle('is-end', quickList.scrollLeft + quickList.clientWidth >= quickList.scrollWidth - 4);
  function drawQuick() {
    const qs = ((cfg || FALLBACK).quick || FALLBACK.quick).slice(0, 8);
    const said = new Set(state.msgs.filter(m => m.r === 'me').map(m => m.t));
    // questions not asked yet come first
    const order = [...qs.filter(q => !said.has(q)), ...qs.filter(q => said.has(q))];
    quickList.replaceChildren(allBtn, ...order.map(q => h('button.ch-q' + (said.has(q) ? '.is-asked' : ''), { type: 'button', onclick: () => { if (ask(q, true)) input.focus({ preventScroll: phone() }); } }, h('span', q), icon('arrow-right'))));
    setQuick(state.quick === null ? !asked() : state.quick);
  }
  quickList.addEventListener('scroll', quickEnd, { passive: true });

  /* ---------- talking to the server ---------- */
  // the turns the server wants: visitor, assistant, visitor ... ending with the question being asked now.
  // Greetings and error notes are not part of it, and an unanswered question drops its older twin.
  function history() {
    const turns = [];
    for (const m of state.msgs) {
      if (m.r === 'sys' || m.bad) continue;
      const role = m.r === 'me' ? 'user' : 'assistant';
      if (!turns.length && role !== 'user') continue;
      if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1] = { role, text: m.t, sig: m.sig };
      else turns.push({ role, text: m.t, sig: m.sig });
    }
    while (turns.length && turns[turns.length - 1].role !== 'user') turns.pop();
    let cut = turns.slice(-MAX_TURNS);
    if (cut.length && cut[0].role !== 'user') cut = cut.slice(1);
    return cut.map(t => (t.role === 'user' ? { role: t.role, text: t.text.slice(0, USER_MAX) } : { role: t.role, text: t.text.slice(0, REPLY_MAX), sig: t.sig }));
  }

  let sending = false;
  const canSend = () => { sendBtn.disabled = sending || !input.value.trim(); };
  function ask(text, fromQuick) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, USER_MAX);
    if (!text || sending) return false;
    sending = true;
    canSend();
    hideUndo();
    add({ r: 'me', t: text, at: Date.now() });
    // the answers get the room: the questions fold to one row unless the visitor opened them by hand
    state.quick = null;
    drawQuick();
    showTyping(true);
    stat(fromQuick ? 'chat.quick' : 'chat.ask');
    answer();
    return true;
  }
  async function answer() {
    let reply, sig = null, bad = false;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hta': '1' }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ messages: history() }) });
      let data = null;
      try { data = await res.json(); } catch (e) { /* answered below */ }
      if (res.ok && data && typeof data.text === 'string' && data.text.trim()) { reply = data.text.trim().slice(0, 4000); sig = typeof data.sig === 'string' ? data.sig : null; }
      else if (res.status === 503 || res.status === 404) { reply = 'The assistant is not switched on here yet. WhatsApp ' + prettyWa() + ' and a person will help.'; bad = true; }
      else { reply = (data && data.error && data.error.message) || 'Something went wrong. Please try again.'; bad = true; }
    } catch (e) {
      reply = 'No connection. Check your signal and try again.'; bad = true;
    }
    // the dots stay for a moment so an instant answer does not snap into place
    await new Promise(r => setTimeout(r, rm() ? 0 : 350));
    showTyping(false);
    add({ r: 'ai', t: reply, at: Date.now(), bad: bad || undefined, sig: sig || undefined });
    // an answer that arrives while the panel is shut is counted on the roundel
    if (!opened) { state.unread = Math.min(9, state.unread + 1); save(); drawBadge(); }
    sending = false;
    canSend();
  }
  function retry(errMsg) {
    // the error note goes, and the question before it is asked again
    const i = state.msgs.indexOf(errMsg);
    if (i < 0 || sending) return;
    const prior = state.msgs.slice(0, i).reverse().find(m => m.r === 'me');
    state.msgs.splice(i, 1);
    if (prior) { const j = state.msgs.indexOf(prior); if (j >= 0) state.msgs.splice(j, 1); }
    save();
    draw();
    if (prior) ask(prior.t);
  }

  /* ---------- starting again ---------- */
  let kept = null, undoTimer = 0;
  function hideUndo() { kept = null; undoBar.hidden = true; clearTimeout(undoTimer); }
  function restart() {
    if (sending || !asked()) return;
    kept = state.msgs;
    state.msgs = [];
    state.quick = null;
    greet();
    draw();
    drawQuick();
    undoBar.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 12000);
    (finePointer.matches ? input : title).focus({ preventScroll: true });
  }
  function undo() {
    if (!kept || sending) return;
    state.msgs = kept;
    hideUndo();
    save();
    draw();
    drawQuick();
    log.focus({ preventScroll: true });
  }
  restartBtn.addEventListener('click', restart);

  /* ---------- opening and closing ---------- */
  let opened = false;
  function greet() {
    if (state.msgs.length) return;
    state.msgs.push({ r: 'sys', t: (cfg || FALLBACK).greeting, at: Date.now() });
    save();
  }
  function applyConfig(c) {
    title.textContent = c.name || FALLBACK.name;
    // the short line says what is answering; the note at the top of the conversation says it in full
    sub.textContent = c.off ? 'Not switched on here' : c.ai ? 'AI assistant' : 'Automatic answers';
    note.textContent = c.off ? 'The assistant is not switched on here yet. WhatsApp a person at the shop instead.'
      : c.ai ? 'AI assistant: your messages go to an AI service to be answered. For prices and stock, WhatsApp a person.' : (c.note || FALLBACK.note);
    waLink.href = 'https://wa.me/' + String(c.whatsapp || WA).replace(/\D/g, '');
    drawQuick();
  }
  function drawBadge() {
    badge.hidden = !state.unread;
    badge.textContent = state.unread ? String(state.unread) : '';
    if (!opened) fab.setAttribute('aria-label', state.unread ? 'Chat with the shop assistant, ' + (state.unread === 1 ? '1 new answer' : state.unread + ' new answers') : 'Chat with the shop assistant');
  }
  function lift() {
    // the launcher sits above the phone docks the home and tyres pages have along the bottom edge
    const dock = $('.dock, .tyres-dock');
    // the home page's dock waits off screen until the opening sections are past: no lift until it is in
    const waiting = dock && dock.classList.contains('dock') && !dock.classList.contains('is-on') && !rm();
    const hgt = dock && !waiting && getComputedStyle(dock).display !== 'none' ? dock.offsetHeight : 0;
    for (const el of [fab, nudge, panel]) el.style.setProperty('--lift', hgt + 'px');
  }
  // a phone's keyboard covers the bottom of the screen without telling the page: the panel follows what is left
  const vv = window.visualViewport;
  function fit() {
    const full = opened && phone();
    panel.toggleAttribute('aria-modal', full);
    if (full) panel.setAttribute('aria-modal', 'true');
    root.classList.toggle('chat-lock', full);
    if (full && vv) {
      panel.style.setProperty('--vvh', Math.round(vv.height) + 'px');
      panel.style.setProperty('--vvt', Math.round(vv.offsetTop) + 'px');
    } else { panel.style.removeProperty('--vvh'); panel.style.removeProperty('--vvt'); }
  }
  function open() {
    if (opened) return;
    opened = true;
    state.open = true; state.nudged = true; state.unread = 0; save();
    nudge.classList.remove('is-on');
    lift();
    fit();
    panel.classList.add('is-open');
    fab.classList.add('is-open');
    fab.setAttribute('aria-expanded', 'true');
    fab.setAttribute('aria-label', 'Close the chat');
    badge.hidden = true;
    loadConfig().then(c => { applyConfig(c); greet(); draw(); });
    if (cfg) greet();
    draw();
    stat('chat.open');
    // a keyboard goes straight to the typing bar; a phone keeps its keyboard down until the visitor wants it
    setTimeout(() => (finePointer.matches && !phone() ? input : title).focus({ preventScroll: true }), rm() ? 0 : 200);
  }
  function close(toFab) {
    if (!opened) return;
    opened = false;
    state.open = false; save();
    panel.classList.remove('is-open');
    fab.classList.remove('is-open');
    fab.setAttribute('aria-expanded', 'false');
    fit();
    drawBadge();
    if (toFab !== false) fab.focus({ preventScroll: true });
  }
  fab.addEventListener('click', () => (opened ? close() : open()));
  nudge.addEventListener('click', open);
  closeBtn.addEventListener('click', () => close());
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    // as a full screen dialog the panel keeps the keyboard inside it
    if (e.key !== 'Tab' || !phone()) return;
    const stops = [...panel.querySelectorAll('a[href], button:not([disabled]), textarea, [tabindex="0"]')].filter(n => !n.hidden && n.getClientRects().length);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === title)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  form.addEventListener('submit', e => { e.preventDefault(); if (sending) return; const t = input.value; if (!ask(t)) return; input.value = ''; state.draft = ''; save(); grow(); input.focus({ preventScroll: true }); });
  // a link tapped inside an answer on a phone: the next page opens without the chat covering it
  log.addEventListener('click', e => { const a = e.target instanceof Element && e.target.closest('a'); if (a && !a.target && phone()) { state.open = false; save(); } });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  // the box grows with the message, up to four lines; the count shows only when the end is near
  let draftTimer = 0;
  const grow = () => {
    input.style.setProperty('height', 'auto');
    input.style.setProperty('height', Math.min(input.scrollHeight, 7.2 * 16) + 'px');
    const n = input.value.length;
    count.hidden = n < USER_MAX - 100;
    count.textContent = n + ' of ' + USER_MAX + ' letters';
    count.classList.toggle('is-full', n >= USER_MAX);
    canSend();
  };
  input.addEventListener('input', () => { grow(); clearTimeout(draftTimer); draftTimer = setTimeout(() => { state.draft = input.value; save(); }, 400); });
  addEventListener('resize', () => { lift(); fit(); quickEnd(); if (opened && following && asked()) toBottom(); }, { passive: true });
  if (vv) { vv.addEventListener('resize', () => { fit(); if (opened && following && asked()) toBottom(); }); vv.addEventListener('scroll', fit); }
  addEventListener('pageshow', e => { if (e.persisted && opened) toBottom(); });
  // the home page's dock slides in only after the hero: follow it
  const dockEl = $('.dock');
  if (dockEl && window.MutationObserver) new MutationObserver(lift).observe(dockEl, { attributes: true, attributeFilter: ['class'] });

  /* ---------- first paint ---------- */
  applyConfig(FALLBACK);
  if (state.draft) { input.value = state.draft; }
  grow();
  lift();
  draw();
  drawBadge();
  const settle = window.requestIdleCallback ? cb => requestIdleCallback(cb, { timeout: 2500 }) : cb => setTimeout(cb, 1500);
  settle(() => loadConfig().then(c => { applyConfig(c); if (opened) { greet(); draw(); } }));
  if (state.open) {
    // the panel was open on the last page: open it again without the travel
    root.classList.add('rm-once');
    open();
    const settled = () => root.classList.remove('rm-once');
    requestAnimationFrame(() => requestAnimationFrame(settled));
    setTimeout(settled, 400);   // a hidden tab gets no frames
  } else if (!state.nudged) {
    // the invitation is spent only when it has really been shown
    const showNudge = () => { if (opened || state.nudged) return; nudge.classList.add('is-on'); state.nudged = true; save(); setTimeout(() => nudge.classList.remove('is-on'), 9000); };
    // on a phone the home page's scroll cue has the same strip of the screen: the cue goes first, and the plate
    // waits until the visitor has scrolled past it
    const cueInTheWay = () => {
      const cue = $('.hero-cue');
      if (!cue || !cue.getClientRects().length) return false;
      const a = cue.getBoundingClientRect(), b = nudge.getBoundingClientRect();
      return a.right > b.left - 12 && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
    };
    setTimeout(() => {
      if (!cueInTheWay()) { showNudge(); return; }
      const onScroll = () => { if (scrollY < 40) return; removeEventListener('scroll', onScroll); showNudge(); };
      addEventListener('scroll', onScroll, { passive: true });
    }, 6000);
  }
})();
