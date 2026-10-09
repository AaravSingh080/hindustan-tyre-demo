/* Shared by the tyre passport and the staff page: talking to the server, small DOM helpers and formatting.
   Everything on these pages is built with text nodes, never innerHTML, so nothing a customer or a member of
   staff typed can turn into markup. */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const SVG = 'http://www.w3.org/2000/svg';

  const icon = name => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'i');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  };

  // h('li.row.is-on', { hidden: true, onclick: fn }, 'text', node, [more nodes])
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

  // replaces what is inside el. Unlike replaceChildren, an absent piece (null or false) is skipped, not printed.
  const fill = (el, ...kids) => { el.replaceChildren(...kids.flat().filter(k => k != null && k !== false)); return el; };

  // the site's number-plate button. opts: { icon, kind: 'k' | 'w', mini, href, type, onclick, ...attributes }
  const plate = (label, { icon: name, kind, mini, href, type, ...attrs } = {}) => {
    const cls = 'plate' + (kind ? ' plate-' + kind : '') + (mini ? ' plate-mini' : '');
    const el = href ? h('a', { class: cls, href, ...attrs }) : h('button', { class: cls, type: type || 'button', ...attrs });
    if (name) el.append(h('span.plate-tab', { 'aria-hidden': 'true' }, icon(name)));
    el.append(h('span.plate-txt', label));
    return el;
  };

  // a vehicle number as a plate. Small ones are buttons that pick a vehicle.
  const vplate = (regNo, { small, ...attrs } = {}) => {
    const el = small ? h('button.vplate.vplate-s', { type: 'button', ...attrs }) : h('div.vplate', attrs);
    el.append(h('span.vplate-tab', { 'aria-hidden': 'true' }, 'IND'), h('span.vplate-txt', fmt.plate(regNo)));
    return el;
  };

  /* ---------- formatting ---------- */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const n = v => Number(v).toLocaleString('en-IN');
  const fmt = {
    n,
    day: s => (s ? `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : ''),
    month: s => (s ? `${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : ''),
    stamp: ms => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; },
    clock: ms => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; },
    plate: r => String(r).replace(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/, (m, a, b, c, d) => [a, b, c, d].filter(Boolean).join(' ')),
    phone: p => String(p).replace(/^\+91(\d{5})(\d{5})$/, '$1 $2'),
    km: v => `${n(v)} km`,
    rupees: paise => `Rs ${n(Math.round(paise / 100))}`,
    mm: v => `${Number(v).toFixed(1)} mm`,
    // "in 19 days", "today", "30 days ago"
    days: d => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d > 0 ? `in ${d} days` : `${-d} days ago`),
    span: d => { const a = Math.abs(d); return a < 60 ? `${a} ${a === 1 ? 'day' : 'days'}` : `${Math.round(a / 30.44)} months`; },
    list: words => (words.length < 2 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1]),
  };

  /* ---------- the server ---------- */
  // api('/api/me') reads; api('/api/x', { ... }) sends. Failures reject with { code, message, field, ... }.
  async function api(path, body, { passive = false } = {}) {
    const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'x-hta': '1' }, credentials: 'same-origin', cache: 'no-store' };
    if (passive) init.headers['x-hta-passive'] = '1';
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, init); } catch (e) { throw { code: 'offline', message: 'No connection. Check your signal and try again.' }; }
    let data = null;
    try { data = await res.json(); } catch (e) { /* handled below */ }
    if (res.ok && data) return data;
    throw (data && data.error) || { code: 'server', message: 'Something went wrong. Please try again.' };
  }

  // a random label for one filling-in of a form, so a double tap or a retry saves once
  const idem = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); };

  /* ---------- views, fields, messages ---------- */
  // shows one [data-view] and moves focus to its heading, so a screen reader hears the change
  function show(name) {
    const now = $(`[data-view="${name}"]`);
    if (now && !now.hidden) return now;   // already on screen: leave the page where the reader is
    let shown = null;
    for (const v of $$('[data-view]')) { v.hidden = v.dataset.view !== name; if (!v.hidden) shown = v; }
    const head = shown && $('[data-focus]', shown);
    if (head) { head.setAttribute('tabindex', '-1'); head.focus({ preventScroll: true }); }
    scrollTo(0, 0);
    return shown;
  }

  // marks a field wrong and says why, next to it; with no field the message goes to the form's status line
  function fail(form, error) {
    const field = error.field && $(`[name="${error.field}"]`, form);
    const status = $('.status', form);
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      let err = $(`#${field.id}-err`);
      if (!err) { err = h('p.err', { id: `${field.id}-err` }); field.closest('.field').append(err); field.setAttribute('aria-describedby', `${field.getAttribute('aria-describedby') || ''} ${err.id}`.trim()); }
      fill(err, icon('warning-circle'), error.message);
      err.hidden = false;
      field.focus();
    } else if (status) { status.textContent = error.message; status.classList.add('is-bad'); }
  }
  function clearErrors(form) {
    for (const f of $$('[aria-invalid="true"]', form)) f.removeAttribute('aria-invalid');
    for (const e of $$('.err', form)) e.hidden = true;
    const status = $('.status', form);
    if (status) { status.textContent = ''; status.classList.remove('is-bad'); }
  }
  // a submit button that cannot be pressed twice while the request is in the air
  async function busy(button, work) {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try { return await work(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  }

  // a short confirmation pinned to the bottom of the screen, so it is seen wherever the page is scrolled to
  const toast = h('p.toast', { id: 'toast', role: 'status', hidden: true });
  document.body.append(toast);
  let toastTimer = 0;
  function say(message, bad) {
    toast.textContent = message;
    toast.classList.toggle('is-bad', !!bad);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 7000);
  }
  // redraw part of the page without the screen jumping
  const inPlace = draw => { const y = scrollY; draw(); scrollTo({ top: y, behavior: 'instant' }); };

  // public settings, fetched once. In demo mode the strip that says so is switched on and stays on.
  let settings = null;
  async function config() {
    if (!settings) {
      settings = await api('/api/public/config');
      const strip = $('#demo-strip');
      if (strip) strip.hidden = settings.mode !== 'demo';
    }
    return settings;
  }

  window.HTA = { $, $$, h, icon, fill, plate, vplate, fmt, api, idem, show, fail, clearErrors, busy, say, inPlace, config };
})();
