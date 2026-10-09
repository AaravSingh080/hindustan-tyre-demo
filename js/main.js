(() => {
  'use strict';

  const BASE = 'https://hindustantyreagencies.com';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const range = (p, a, b) => clamp01((p - a) / (b - a));
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // respects the OS setting; ?motion=reduce forces the static layout
  const RM = document.documentElement.classList.contains('rm');
  const mqDesk = matchMedia('(min-width: 900px)');
  // visitors on Data Saver, or on a link too slow to carry them, keep the stills and skip the frame sequences
  const LITE = !!(navigator.connection && (navigator.connection.saveData || /(^|-)2g$/.test(navigator.connection.effectiveType || '')));

  /* Scroll scenes. Each scrubs a frame sequence exported from a clip with tools/make-sequence.sh (the hero
     with tools/make-hero-sequence.sh). Until frames arrive (or on Data Saver) the still is drawn with a
     scripted camera move instead. The hero, net and grip each play across their whole section. */
  const seq = (name, count, extra) => (LITE ? null : { dir: 'assets/seq/' + name, count, ext: 'webp', ...extra });
  // the hero has two cuts of the one clip: the full frame, and a tall one for phones held upright.
  // first: frames fetched before the rest, in order, for the opening move. blend: two frames are mixed
  // between steps, so slow scrolling does not judder.
  const mqTall = matchMedia('(max-width: 899px) and (orientation: portrait)');
  const HERO_FRAMES = 73, HERO_FIRST = 18;
  const heroCfg = () => (mqTall.matches
    ? { still: 'assets/img/scenes/hero-film-tall.webp', fit: 'cover', blend: true, quality: 'low', maxDpr: 1.5, frames: seq('hero-tall', HERO_FRAMES, { first: HERO_FIRST }), move: p => ({ s: 1 + 1.9 * easeInOut(p), fx: 0.5, fy: 0.52 }) }
    : { still: 'assets/img/scenes/hero-film.webp', fit: 'cover', blend: true, quality: 'low', frames: seq('hero', HERO_FRAMES, { first: HERO_FIRST }), move: p => ({ s: 1 + 1.9 * easeInOut(p), fx: 0.66, fy: 0.52 }) });
  const SCENE_CONFIG = {
    net: { still: 'assets/img/scenes/highway.webp', fit: 'cover', frames: seq('net', 73), move: p => ({ s: 1 + 0.6 * easeInOut(p), fx: 0.5, fy: 0.27 }) },
    grip: { still: 'assets/img/scenes/grip.webp', fit: 'cover', frames: seq('grip', 73), move: p => ({ s: 1.22 - 0.22 * p, fx: 0.42, fy: 0.62 }) }
  };

  /* ---------- road lettering: every word arrives as laid and finishes as read ---------- */
  // Text here is road paint, in the three families the road code (IRC:35) knows. A heading is a word message:
  // stencilled lettering that arrives long, the way letters are painted on a carriageway, with the ties of the
  // stencil still open and no glass beads on. It stands long up the empty road above it, pulls down into
  // reading proportion with the distance travelled, then the ties are trowelled shut and the beads go on.
  // Running text is a lane line: it takes its beads a line at a time. A block is a bar marking: it is felt as
  // it is crossed, one bar after another. Nothing is ever hidden. State is a class on the element (is-raw >
  // is-run > is-tie > is-bead, or is-tick, or is-thud > is-set) and update() moves it on. Every unfinished look
  // sits behind html.road, added last (see roadArm) and taken away if anything throws.
  const root = document.documentElement;
  const road = { on: false, items: [], live: new Set(), waiting: [], hero: [], proof: [], still: 0, flew: 0 };
  // D: screens of travel that finish it. T: seconds that finish it standing still. after: the closing beats.
  // Three sections have headings that are not carriageway paint (data-split says which): lamp is the message
  // sign over a highway, struck a row of lamps at a time; air is the inflator, pumped up a stroke at a time;
  // true is the alignment rig, brought upright. They are driven exactly as a word is; only the look differs.
  const ROAD = {
    word: { D: 0.34, T: 0.65, after: ['tie', 'bead'] },
    lamp: { D: 0.3, T: 0.6, after: ['hold', 'fuse'] },
    air: { D: 0.3, T: 0.7, after: ['seat'] },
    true: { D: 0.3, T: 0.6, after: ['lock'] },
    proof: { D: 1, T: 1, after: ['tie', 'bead'] },
    lane: { D: 0.16, T: 0.45, after: ['tick'] },
    bar: { D: 0.18, T: 0.45, after: ['thud'] }
  };
  const ROAD_HEADS = { word: 1, lamp: 1, air: 1, true: 1 };
  const ROAD_BEAT = { tie: 0.16, bead: 0.1, thud: 0.12, hold: 0.22, fuse: 0.08, seat: 0.12, lock: 0.12 };   // seconds; a tick is 0.06 for each line of the paragraph
  const ROAD_STATES = ['is-raw', 'is-run', 'is-tie', 'is-bead', 'is-tick', 'is-thud', 'is-hold', 'is-fuse', 'is-seat', 'is-lock'];
  const ROAD_VARS = ['--lit', '--sy', '--psi', '--toe'];
  const LAMP_ROWS = 12;                               // rows of lamps to a line of lettering (css: --lh / --pt)
  const AIR_STROKES = [0.64, 0.73, 0.81, 0.88, 0.94];   // the height the lettering stands at after each stroke of the pump
  const roadAdd = (node, kind, opt) => {
    const it = Object.assign({ el: node, kind, phase: 'set', q: 0, t: 0, n: 1, lag: 0, life: 0, L0: 2.6, h: 0, bottom: Infinity, enter: Infinity, ref: Infinity, hero: false, lead: null, cap: null }, opt);
    node._road = it;
    road.items.push(it);
    return it;
  };
  const roadClear = it => {
    it.el.classList.remove(...ROAD_STATES);
    it.el.style.transform = '';
    if (it.cap) it.cap.style.transform = '';
    if (it.kind !== 'word' && ROAD_HEADS[it.kind]) { ROAD_VARS.forEach(v => it.el.style.removeProperty(v)); it.step = -1; }
  };
  // one frame of a heading on its way in, at progress q (0 as laid, 1 as read)
  const roadDraw = (it, q) => {
    const s = it.el.style;
    if (it.kind === 'word') {
      const L = 1 + (it.L0 - 1) * Math.pow(1 - q, it.hero ? 3 : 2.2);
      s.transform = `scaleY(${L.toFixed(3)})`;
      // a kicker over the heading rides on top of the lettering
      if (it.cap) it.cap.style.transform = `translate3d(0,${(-(L - 1) * it.h).toFixed(1)}px,0)`;
    } else if (it.kind === 'lamp') {
      // lamps strike a whole row at a time: the style is written only when another row comes on
      const row = Math.floor(q * LAMP_ROWS);
      if (row !== it.step) { it.step = row; s.setProperty('--lit', row); }
    } else if (it.kind === 'air') {
      const k = Math.min(AIR_STROKES.length - 1, Math.floor(q * AIR_STROKES.length));
      if (k !== it.step) { it.step = k; s.setProperty('--psi', k); s.setProperty('--sy', AIR_STROKES[k]); s.transform = `scaleY(${AIR_STROKES[k]})`; }
    } else {
      const toe = Math.pow(1 - q, 1.6);
      s.setProperty('--toe', toe.toFixed(3));
      s.transform = `skewX(${(-6 * toe).toFixed(2)}deg)`;
    }
  };
  const roadSet = it => {
    roadClear(it);
    it.el.classList.add('is-set');
    if (it.kind === 'proof') it.el.classList.add('on');
    it.phase = 'set';
    road.live.delete(it);
  };
  // back to as laid: only the hero promises do this, when the page is scrolled back above them
  const roadRaw = it => {
    roadClear(it);
    it.el.classList.remove('is-set', 'on');
    it.el.classList.add('is-raw');
    it.phase = 'wait';
    road.live.delete(it);
  };
  const roadNext = it => {
    const after = ROAD[it.kind].after;
    const next = after[after.indexOf(it.phase) + 1];   // indexOf is -1 while it is still pulling in, so this is the first beat
    if (!next) { roadSet(it); return; }
    roadClear(it);
    it.el.classList.add('is-' + next);
    it.phase = next;
    it.t = next === 'tick' ? it.n * 0.06 : ROAD_BEAT[next];
  };
  const roadStart = it => {
    if (it.phase !== 'wait') return;   // already finished some other way (a control that took focus while its bar waited)
    it.phase = 'run';
    it.q = it.kind === 'proof' ? 1 : 0;
    it.life = 0;
    it.el.classList.add('is-run');
    road.live.add(it);
  };
  const roadStep = (it, dt, far, still, sy, vh) => {
    // nothing may be left unfinished: four seconds after it started, whatever happened, it is finished paint
    it.life += dt;
    if (it.life > 4) { roadSet(it); return; }
    if (it.phase !== 'run') { it.t -= dt; if (it.t <= 0) roadNext(it); return; }
    const R = ROAD[it.kind];
    if (ROAD_HEADS[it.kind]) {
      if (it.hero) it.q += dt / 0.9 + far / 0.42;   // no scroll to drive the headline: it runs on the clock from the moment the loading plate lifts
      else {
        // it closes with the distance travelled once the whole of it is on screen and clear of the dock. The
        // clock runs alongside, slowly while the page moves and at full rate once it stands still, so nothing
        // is ever left long. On a slow unbroken scroll the wait for the whole of it to come up can use most of
        // the four seconds a piece is allowed: from then the clock runs at full rate too, so the heading
        // closes and takes its beats in good time and the net never cuts it short in one frame.
        const seen = (sy + vh - it.bottom - M.roadClear) / (R.D * vh);
        it.q = Math.max(it.q, Math.min(1, seen)) + (still || it.life > 4 - R.T - 0.8 ? dt / R.T : seen > 0 ? 0.3 * dt / R.T : 0);
      }
      if (it.q < 1) { roadDraw(it, Math.max(0, it.q)); return; }
    } else if (it.kind !== 'proof') {
      it.q += (still ? 1 : 0.35) * dt / R.T + far / R.D;
      if (it.q < 1) return;
    }
    // reading order: nothing under a heading takes its finish while the heading is still pulling in
    if (it.lead && it.lead.phase === 'run') return;
    // bars in a row are crossed one after another: each waits its turn
    if (it.lag > 0) it.lag -= dt; else roadNext(it);
  };
  // Data Saver visitors get finished text and no work at all
  if (!RM && !LITE) {
    $$('h2[data-split]').forEach(h => {
      const k = h.previousElementSibling, kind = ROAD_HEADS[h.dataset.split] ? h.dataset.split : 'word';
      roadAdd(h, kind, { step: -1, cap: kind === 'word' && k && k.classList.contains('kicker') ? k : null });
    });
    $$('[data-reveal]').forEach(n => {
      if (n.matches('p')) { roadAdd(n, 'lane'); return; }
      // a row is a set of bars, 0.06s apart; anything else is one bar
      const bars = $$(':scope > li, :scope > h3, :scope > ul > li, :scope > a', n);
      if (n.matches('li') || !bars.length) roadAdd(n, 'bar', { lag: n.matches('li') ? [...n.parentElement.children].indexOf(n) * 0.06 : 0 });
      else bars.forEach((b, i) => roadAdd(b, 'bar', { lag: i * 0.06 }));
    });
    const heroWord = roadAdd($('#hero-title'), 'word', { hero: true });
    roadAdd($('.hero-side'), 'bar', { hero: true, lag: 0.1, lead: heroWord });
    roadAdd($('.hero-cue'), 'bar', { hero: true, lag: 0.3, lead: heroWord });
    // the three promises in the hero are word messages that keep their height: the scroll finishes them one by one
    $$('.hero-proof li').forEach(li => road.proof.push(roadAdd(li, 'proof')));
    // each paragraph and bar follows the heading of its own section
    const heads = road.items.filter(it => ROAD_HEADS[it.kind] && !it.hero);
    road.items.forEach(it => {
      const sec = !it.hero && (it.kind === 'lane' || it.kind === 'bar') && it.el.closest('section');
      if (sec) it.lead = heads.find(h => sec.contains(h.el)) || null;
    });
    // One pass of reads, then one of writes. Whatever is already on screen or behind the visitor (a deep link, a
    // restored scroll position, a script that arrived late) is finished paint and never goes raw. A heading
    // stands up to twice its own height above itself, so it counts as ahead only when that is still below the edge.
    const landed = scrollY > 4 || !root.classList.contains('is-loading');
    const edge = innerHeight;
    const ahead = road.items.map(it => {
      if (it.hero) return !landed;
      if (it.kind === 'proof') return true;
      return it.el.getBoundingClientRect().top - (it.kind === 'word' ? 2 * it.el.offsetHeight : 0) >= edge;
    });
    road.items.forEach((it, i) => {
      if (!ahead[i]) return;
      it.phase = 'wait';
      it.el.classList.add('rl', it.kind === 'proof' ? 'rl-word' : 'rl-' + it.kind, 'is-raw');
      if (ROAD_HEADS[it.kind]) it.el.classList.add('rl-head');
      // anything that can be pressed is never dimmed
      if (it.kind === 'bar' && (it.el.matches('a, button, .board') || it.el.querySelector('a, button, input, select'))) it.el.classList.add('rl-solid');
      if (it.hero) { road.hero.push(it); road.heroBusy = true; }
      else if (it.kind !== 'proof') road.waiting.push(it);
    });
    // a control focused while its bar is still unfinished is finished at once: a focus ring never sits on dull paint
    document.addEventListener('focusin', e => {
      const bar = e.target instanceof Element && e.target.closest('.rl');
      if (bar && bar._road && bar._road.phase !== 'set' && bar._road.kind !== 'proof') roadSet(bar._road);
    });
    // an in-page link lands on finished paint, however slowly the browser eases to a stop
    document.addEventListener('click', e => { if (e.target instanceof Element && e.target.closest('a[href^="#"]')) road.flew = 1.6; });
  }
  // the gate: called as the last thing before the loop starts, so an error anywhere above leaves plain finished text
  const roadOff = () => {
    road.on = false;
    root.classList.remove('road');
    road.items.forEach(it => { it.el.style.transform = ''; if (it.cap) it.cap.style.transform = ''; ROAD_VARS.forEach(v => it.el.style.removeProperty(v)); });
  };
  const roadArm = () => {
    if (!road.items.some(it => it.phase === 'wait')) return;
    road.on = true;
    root.classList.add('road');
    // update() runs before the next frame is asked for, so a throw inside it stops the loop for good
    addEventListener('error', roadOff);
    // paper gets finished lettering in its own colours
    addEventListener('beforeprint', roadOff);
  };

  /* ---------- gallery shots open as their figure comes into view ---------- */
  const shotFigures = $$('.gallery figure');
  const openShot = fig => $('.shot', fig).classList.add('in');
  if (RM || !('IntersectionObserver' in window)) {
    shotFigures.forEach(openShot);
  } else {
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      openShot(e.target);
      io.unobserve(e.target);
    }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    shotFigures.forEach(fig => io.observe(fig));
  }

  /* ---------- count-up ---------- */
  const fmt = n => n.toLocaleString('en-IN');
  function countUp(el) {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    const end = +el.dataset.count;
    const t0 = performance.now();
    (function tick(now) {
      const p = clamp01((now - t0) / 1300);
      el.textContent = fmt(Math.round(end * easeOut(p)));
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }

  /* ---------- header: vehicle menu ---------- */
  const header = $('#header');
  const navBtn = $('.nav-btn');
  const navItem = navBtn.closest('.has-menu');
  const menuBox = $('#menu-vehicle');
  const setMenu = open => {
    navBtn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // the panel is wider than the button it hangs from: slide it sideways until it is inside the window
    const c = navItem.getBoundingClientRect(), w = menuBox.offsetWidth, pad = 16;
    const left = c.left + c.width / 2 - w / 2;
    const over = left < pad ? pad - left : left + w > innerWidth - pad ? innerWidth - pad - left - w : 0;
    menuBox.style.setProperty('--nudge', Math.round(over) + 'px');
  };
  navBtn.addEventListener('click', () => setMenu(navBtn.getAttribute('aria-expanded') !== 'true'));
  navItem.addEventListener('mouseenter', () => setMenu(true));
  navItem.addEventListener('mouseleave', () => setMenu(false));
  navItem.addEventListener('focusout', e => { if (!navItem.contains(e.relatedTarget)) setMenu(false); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && navBtn.getAttribute('aria-expanded') === 'true') { setMenu(false); navBtn.focus(); }
  });
  document.addEventListener('click', e => { if (!navItem.contains(e.target)) setMenu(false); });

  /* ---------- dialogs: phone menu ---------- */
  const menu = $('#menu');
  const menuOpen = $('.menu-open');
  menuOpen.addEventListener('click', () => menu.showModal());
  menu.addEventListener('close', () => menuOpen.focus());
  $$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('a', menu).forEach(a => a.addEventListener('click', () => menu.close()));

  /* ---------- gallery viewer ---------- */
  const viewer = $('#viewer');
  const shots = $$('.shot');
  const viewerImg = $('img', viewer);
  const viewerCap = $('figcaption', viewer);
  let shotIndex = 0;
  let shotOpener = null;
  function showShot(i) {
    shotIndex = (i + shots.length) % shots.length;
    const shot = shots[shotIndex];
    viewerImg.src = shot.dataset.full;
    viewerImg.alt = $('img', shot).alt;
    viewerCap.textContent = shot.closest('figure').querySelector('figcaption').textContent;
  }
  shots.forEach((shot, i) => shot.addEventListener('click', () => { shotOpener = shot; showShot(i); viewer.showModal(); }));
  viewer.addEventListener('close', () => { if (shotOpener) shotOpener.focus(); });
  $('.viewer-prev').addEventListener('click', () => showShot(shotIndex - 1));
  $('.viewer-next').addEventListener('click', () => showShot(shotIndex + 1));
  viewer.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') showShot(shotIndex - 1);
    if (e.key === 'ArrowRight') showShot(shotIndex + 1);
  });
  viewer.addEventListener('click', e => { if (e.target === viewer) viewer.close(); });

  /* ---------- tyre finder (same tag URLs as the live store) ---------- */
  const DATA = window.HTA_DATA || { vehicles: {}, sizes: [] };
  // the same spelling as js/tyres.js, so a company or a model reads the same on both pages
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const MAKE_LABELS = { bmw: 'BMW', mg: 'MG', byd: 'BYD', range: 'Range Rover', 'mercedes-benz': 'Mercedes Benz' };
  const ACRONYMS = ['ev', 'gt', 'gti', 'amg', 'g', 'suv', 'xuv', 'kuv', 'tuv', 'xl', 'zx', 'glc', 'gle', 'gls', 'gla', 'glb', 'zs', 'mu', 'cls', 'cla'];
  const TOP_MAKES = ['maruti-suzuki', 'hyundai', 'mahindra', 'tata', 'toyota', 'honda'];
  const prettyToken = w => {
    if (!w) return w;
    if (ACRONYMS.includes(w)) return w.toUpperCase();
    if (/^[a-z]+\d/.test(w) || /^\d+[a-z]+$/.test(w) || /^[a-z]$/.test(w) || /^\d+$/.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  const pretty = s => (own(MAKE_LABELS, s) ? MAKE_LABELS[s] : s.split('-').map(prettyToken).join(' '));
  const byLabel = (a, b) => pretty(a).localeCompare(pretty(b));
  const slug = v => String(v || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slugSize = v => slug(String(v || '').replace(/[a-zA-Z]/g, ''));
  const tagUrl = tags => BASE + '/collections/all/' + tags.map(encodeURIComponent).join('+');
  const KNOWN_SIZES = new Set(DATA.sizes.map(slug));

  const tabs = $$('[role="tab"]');
  const panels = $$('[role="tabpanel"]');
  function selectTab(tab, focus) {
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach(p => { p.hidden = p.id !== tab.getAttribute('aria-controls'); });
    tab.parentElement.style.setProperty('--tab', String(tabs.indexOf(tab)));
    if (focus) tab.focus();
  }
  // a filled field keeps its tab lit; a model list that has just arrived drops onto its edge
  const fieldDone = sel => sel.closest('.fplate').classList.toggle('is-done', !!sel.value);
  const fieldDrop = sel => { const f = sel.closest('.fplate'); f.classList.remove('is-drop'); void f.offsetWidth; f.classList.add('is-drop'); };
  $$('.fplate select, .fplate input').forEach(n => { n.addEventListener('change', () => fieldDone(n)); n.addEventListener('input', () => fieldDone(n)); });
  // the lane rail fills to the end as the page hands over to the shop
  const leaving = () => document.documentElement.classList.add('is-leaving');
  addEventListener('pageshow', e => { if (e.persisted) document.documentElement.classList.remove('is-leaving'); $$('.fplate select, .fplate input').forEach(fieldDone); });

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (e.key === 'Home') { e.preventDefault(); selectTab(tabs[0], true); }
      if (e.key === 'End') { e.preventDefault(); selectTab(tabs[tabs.length - 1], true); }
      if (dir) { e.preventDefault(); selectTab(tabs[(i + dir + tabs.length) % tabs.length], true); }
    });
  });

  const brandSel = $('#f-brand');
  const modelSel = $('#f-model');
  const brandErr = $('#f-brand-err');
  const option = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; };
  const optgroup = (label, makes) => { const g = document.createElement('optgroup'); g.label = label; makes.forEach(m => g.appendChild(option(m, pretty(m)))); return g; };
  const allMakes = Object.keys(DATA.vehicles);
  const topMakes = TOP_MAKES.filter(m => allMakes.includes(m));
  if (topMakes.length) brandSel.appendChild(optgroup('Most chosen', topMakes));
  brandSel.appendChild(optgroup(topMakes.length ? 'All other companies, A to Z' : 'A to Z', allMakes.filter(m => !topMakes.includes(m)).sort(byLabel)));
  function setFieldError(input, errEl, on) {
    errEl.hidden = !on;
    if (on) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
  brandSel.addEventListener('change', () => {
    const make = brandSel.value;
    setFieldError(brandSel, brandErr, false);
    modelSel.textContent = '';
    modelSel.appendChild(option('', make ? 'All ' + pretty(make) + ' Models' : 'Select Model'));
    (own(DATA.vehicles, make) ? [...DATA.vehicles[make]] : []).sort(byLabel).forEach(m => modelSel.appendChild(option(m, pretty(m))));
    fieldDone(modelSel);
    if (make && !RM) fieldDrop(modelSel);
    modelSel.disabled = !make;
  });
  $('#panel-vehicle').addEventListener('submit', e => {
    e.preventDefault();
    const make = brandSel.value;
    if (!make) { setFieldError(brandSel, brandErr, true); brandSel.focus(); return; }
    const tags = ['make-' + make];
    if (modelSel.value) tags.push('model-' + make + '-' + modelSel.value);
    if (window.HTA_STAT) window.HTA_STAT('finder.vehicle');
    leaving();
    location.href = tagUrl(tags);
  });

  const sizeInput = $('#f-size');
  const sizeErr = $('#f-size-err');
  const sizeUnavailable = $('#size-unavailable');
  const sizeList = $('#size-list');
  DATA.sizes.filter(t => /^[0-9]+([.\/-][0-9a-zA-Z]+)+$/.test(t) && !/x/i.test(t)).forEach(t => sizeList.appendChild(option(t, t)));
  function searchSize(value) {
    const size = KNOWN_SIZES.has(slug(value)) ? slug(value) : slugSize(value);
    sizeUnavailable.hidden = true;
    if (!size) { setFieldError(sizeInput, sizeErr, true); sizeInput.focus(); return; }
    setFieldError(sizeInput, sizeErr, false);
    if (!KNOWN_SIZES.has(size)) { sizeUnavailable.hidden = false; return; }
    if (window.HTA_STAT) window.HTA_STAT('finder.search');
    leaving();
    location.href = tagUrl([size]);
  }
  $('#panel-size').addEventListener('submit', e => { e.preventDefault(); searchSize(sizeInput.value); });
  sizeInput.addEventListener('input', () => { setFieldError(sizeInput, sizeErr, false); sizeUnavailable.hidden = true; });
  $$('button[data-size]').forEach(chip => chip.addEventListener('click', () => {
    selectTab($('#tab-size'));
    sizeInput.value = chip.dataset.size;
    searchSize(chip.dataset.size);
  }));
  $$('[data-search-size]').forEach(link => link.addEventListener('click', () => {
    selectTab($('#tab-size'));
    sizeInput.value = link.dataset.searchSize;
    setTimeout(() => sizeInput.focus({ preventScroll: true }), 900);
  }));

  /* ---------- newsletter ---------- */
  const newsForm = $('#news-form');
  const newsEmail = $('#news-email');
  const newsErr = $('#news-err');
  newsForm.addEventListener('submit', e => {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newsEmail.value.trim());
    setFieldError(newsEmail, newsErr, !ok);
    if (!ok) { e.preventDefault(); newsEmail.focus(); }
  });
  newsEmail.addEventListener('input', () => setFieldError(newsEmail, newsErr, false));

  /* ---------- canvas scene: scrubbed frame sequence, with a still + camera move as fallback ---------- */
  class Scene {
    constructor(canvas, cfg) {
      this.cv = canvas;
      this.g = canvas.getContext('2d', { alpha: false });
      this.cfg = cfg;
      this.img = null;
      this.frames = [];
      this.p = 0;
      this.x = 0;
      this.dirty = true;
      this.loaded = false;
    }
    load() {
      if (this.loaded) return;
      this.loaded = true;
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => { this.img = im; this.dirty = true; this.resize(); this.draw(this.p); };
      im.src = this.cfg.still;
      if (this.cfg.frames) this.loadFrames();
    }
    setFrames(frames) { this.cfg.frames = frames; this.frames = []; this.framesStarted = false; if (this.loaded) this.loadFrames(); }
    // another cut of the same scene (the hero swaps between wide and tall when a phone is turned)
    // the poster (which the page has already switched to the right cut) shows until the first frame of the new one is drawn
    swap(cfg) { this.cfg = cfg; this.img = null; this.frames = []; this.framesStarted = false; this.loaded = false; this.dirty = true; this.cv.parentElement.classList.remove('is-live'); this.load(); }
    // true once the first n frames have all arrived
    ready(n) { for (let i = 0; i < n; i++) if (!this.frames[i]) return false; return true; }
    loadFrames() {
      const f = this.cfg.frames;
      if (!f || this.framesStarted) return;
      this.framesStarted = true;
      const order = [];
      const seen = new Set();
      const want = i => { if (i < f.count && !seen.has(i)) { seen.add(i); order.push(i); } };
      // every eighth frame first, so the scroll can move the picture after ten requests on any connection; then
      // the opening frames in order, where a scene asks for them; then finer and finer
      for (let i = 0; i < f.count; i += 8) want(i);
      for (let i = 0; i < (f.first || 0); i++) want(i);
      [4, 2, 1].forEach(step => { for (let i = 0; i < f.count; i += step) want(i); });
      let k = 0;
      const next = () => {
        if (k >= order.length || this.cfg.frames !== f) return;
        const i = order[k++];
        const im = new Image();
        const keep = () => { if (this.cfg.frames === f) { this.frames[i] = im; this.dirty = true; } next(); };
        // kept as soon as it has arrived: a canvas decodes a frame when it first draws it whatever was done before,
        // so waiting on decode() here only doubled the work and held the next request back
        im.onload = keep;
        im.onerror = next;
        im.src = `${f.dir}/f_${String(i + 1).padStart(4, '0')}.${f.ext || 'webp'}`;
      };
      for (let c = 0; c < 4; c++) next();
    }
    nearestFrame(i) {
      const n = this.cfg.frames.count;
      for (let d = 0; d < n; d++) {
        if (this.frames[i - d]) return this.frames[i - d];
        if (this.frames[i + d]) return this.frames[i + d];
      }
      return null;
    }
    resize() {
      const d = Math.min(this.cfg.maxDpr || 2, devicePixelRatio || 1);
      const w = Math.round(this.cv.clientWidth * d);
      const h = Math.round(this.cv.clientHeight * d);
      if (w && h && (w !== this.cv.width || h !== this.cv.height)) { this.cv.width = w; this.cv.height = h; this.dirty = true; }
    }
    draw(p) {
      if (!this.dirty && Math.abs(p - this.p) < 0.0004) return;
      this.p = p;
      const { g, cfg } = this;
      const w = this.cv.width, h = this.cv.height;
      let src = this.img, over = null, mix = 0;
      let cam = cfg.move ? cfg.move(p) : { s: 1, fx: 0.5, fy: 0.5 };
      if (cfg.frames) {
        const x = p * (cfg.frames.count - 1);
        const frame = this.nearestFrame(Math.round(x));
        if (frame) { src = frame; cam = { s: 1, fx: 0.5, fy: 0.5 }; }
        // between two frames that have both arrived, the later one is laid over the earlier. Only while the
        // scrub is slow: at speed the eye cannot tell, and one frame a paint is one decode a paint.
        if (cfg.blend && Math.abs(x - this.x) < 1) {
          const a = Math.floor(x), fa = this.frames[a], fb = this.frames[a + 1];
          if (fa && fb) { src = fa; over = fb; mix = x - a; }
        }
        this.x = x;
      }
      if (!src || !w) return;
      this.dirty = false;
      const iw = src.naturalWidth, ih = src.naturalHeight;
      const base = cfg.fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
      const x0 = (w - iw * base) / 2, y0 = (h - ih * base) / 2;
      // zoom about the focal point so it stays where it was on screen
      const fxs = x0 + cam.fx * iw * base, fys = y0 + cam.fy * ih * base;
      const s = base * cam.s;
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, h);
      g.imageSmoothingQuality = cfg.quality || 'high';
      g.drawImage(src, fxs - cam.fx * iw * s, fys - cam.fy * ih * s, iw * s, ih * s);
      if (over && mix > 0.02) { g.globalAlpha = mix; g.drawImage(over, fxs - cam.fx * iw * s, fys - cam.fy * ih * s, iw * s, ih * s); g.globalAlpha = 1; }
      this.cv.parentElement.classList.add('is-live');
    }
  }

  const scenes = {};
  const heroCut = { w: innerWidth, stale: false };
  if (!RM) {
    // the hero is the first thing on screen: its frames start at once, the others when they come near
    scenes.hero = new Scene($('#hero-canvas'), heroCfg());
    scenes.hero.load();
    // a keyboard or a split screen makes the window short without turning the phone: the cut changes only when
    // the width has changed too, and is fetched only when the hero is near enough to be seen (see update)
    mqTall.addEventListener('change', () => { if (innerWidth === heroCut.w) return; heroCut.w = innerWidth; heroCut.stale = true; });
    scenes.net = new Scene($('#net-canvas'), SCENE_CONFIG.net);
    scenes.grip = new Scene($('#grip-canvas'), SCENE_CONFIG.grip);
    const lazy = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      (e.target.id === 'net-canvas' ? scenes.net : scenes.grip).load();
      lazy.unobserve(e.target);
    }), { rootMargin: '150% 0px' });
    lazy.observe(scenes.net.cv);
    lazy.observe(scenes.grip.cv);
  }

  /* ---------- plates press and stamp ---------- */
  // the plate under the first finger or the mouse button sinks; it stamps back up only when released on itself
  let pressedPlate = null;
  const plateOf = e => (e.target instanceof Element ? e.target.closest('.plate') : null);
  const releasePlate = stamp => {
    const el = pressedPlate;
    pressedPlate = null;
    if (!el) return;
    el.classList.remove('is-pressed');
    if (stamp && !RM) { el.classList.remove('is-stamp'); void el.offsetWidth; el.classList.add('is-stamp'); }
  };
  document.addEventListener('pointerdown', e => { const p = plateOf(e); if (p && e.button === 0 && e.isPrimary) { pressedPlate = p; p.classList.add('is-pressed'); } });
  document.addEventListener('pointerup', e => releasePlate(plateOf(e) === pressedPlate), true);
  document.addEventListener('pointercancel', () => releasePlate(false), true);
  document.addEventListener('keydown', e => { const p = plateOf(e); if (p && (e.key === ' ' || e.key === 'Enter') && !e.repeat) { pressedPlate = p; p.classList.add('is-pressed'); } });
  document.addEventListener('keyup', () => releasePlate(true));
  $$('.faq-list details').forEach(d => d.addEventListener('toggle', () => d.classList.add('is-touched')));

  // the closing plate's lettering, one glyph at a time, so it can stamp in when the plate rises
  const bigTxt = $('.bigplate-txt');
  if (bigTxt && !RM) {
    const chars = bigTxt.textContent.split('');
    bigTxt.textContent = '';
    chars.forEach((ch, i) => {
      const sp = document.createElement('span');
      sp.className = 'bc';
      sp.textContent = ch === ' ' ? String.fromCharCode(160) : ch;
      sp.style.setProperty('--c', String(i));
      sp.style.setProperty('--t', i % 2 ? '-1' : '1');
      bigTxt.appendChild(sp);
    });
  }

  /* ---------- hero: opening move ---------- */
  // once the loading screen lifts, the camera settles back from a little way in, so the picture is seen to
  // move before anyone scrolls. It runs only if those frames have arrived and the page is at the top.
  const intro = { from: 0.2, ms: 1700, at: 0, done: RM };

  /* ---------- brand marquee ---------- */
  const marquee = $('.marquee');
  const track = $('.marquee-track');
  const marqueeBtn = $('.marquee-toggle');
  const mq = { x: 0, cycle: 0, skew: 0, paused: false, hover: false, visible: false };
  if (!RM) {
    const originals = [...track.children];
    for (let n = 0; n < 2; n++) originals.forEach(li => {
      const c = li.cloneNode(true);
      c.setAttribute('aria-hidden', 'true');
      $('img', c).alt = '';
      track.appendChild(c);
    });
    marquee.addEventListener('mouseenter', () => { mq.hover = true; });
    marquee.addEventListener('mouseleave', () => { mq.hover = false; });
    new IntersectionObserver(es => { mq.visible = es[0].isIntersecting; }).observe(marquee);
    marqueeBtn.addEventListener('click', () => {
      mq.paused = !mq.paused;
      marqueeBtn.setAttribute('aria-pressed', String(mq.paused));
      $('.plate-txt > span', marqueeBtn).textContent = mq.paused ? 'Play' : 'Pause';
      $('use', marqueeBtn).setAttribute('href', mq.paused ? '#i-play' : '#i-pause');
    });
  }

  /* ---------- scroll engine: one rAF loop owns every scroll-linked effect ---------- */
  const el = {
    announce: $('.announce'),
    hero: $('.hero'), heroPin: $('.hero-pin'), heroFilm: $('.hero-film'), heroIn: $('.hero-in'), heroTitle: $('#hero-title'), heroCue: $('.hero-cue'),
    heroProof: $('.hero-proof'), heroProofs: $$('.hero-proof li'),
    size: $('.size'), sizePin: $('.size-pin'), stageIn: $('.size-stage-in'), explain: $('.size-explain'),
    cats: $('.cats'), catsTrack: $('.cats-track'), catsBar: $('.cats-progress span'), catCards: $$('.cat'),
    net: $('.net'), netPin: $('.net-pin'), stones: $$('.stone'), routeLine: $('.route-line span'), stops: $$('.route-stops li'),
    chevrons: $('.chevrons-in'), gallery: $('.gallery-grid'), gcols: $$('.gcol'),
    cards: $$('.stack-card'), consult: $('.consult'), plateWrap: $('.bigplate-wrap'), plate: $('.bigplate'),
    dock: $('.dock'), odo: $('.odo'), odoDigits: $$('.odo-d i'),
    rail: $('.rail span'), rim: $('.badge-rim')
  };
  const dimKeys = ['w', 'p', 'r'];
  const dimEls = {};
  dimKeys.forEach(k => { dimEls[k] = $$(`[data-dim="${k}"]`); });
  $$('.dims path').forEach(p => p.setAttribute('pathLength', '1'));
  if (RM) $$('.size-key > div, .size-code span').forEach(n => n.classList.add('on'));

  const M = {};
  const S = { hero: 0, film: 0, size: 0, cats: 0, net: 0, roll: 0 };
  let first = true;
  let lastY = scrollY;
  let lastTrip = -1;
  let prev = performance.now();
  const damp = (cur, target, dt, k = 9) => (first ? target : lerp(cur, target, 1 - Math.exp(-k * dt)));
  const docTop = node => node.getBoundingClientRect().top + scrollY;
  // the headline and its buttons slide out under the camera as the scroll runs but stay in the page for screen
  // readers; if the keyboard lands on one of them, the page goes back to where it can be seen. A mouse press
  // also focuses a link: that is a click on something already in view, and the page must not move under it.
  const byKeyboard = node => { try { return node.matches(':focus-visible'); } catch (e) { return true; } };
  el.heroIn.addEventListener('focusin', e => { if (!RM && !M.hero.flat && S.hero > 0.03 && byKeyboard(e.target)) scrollTo({ top: 0, behavior: 'instant' }); });
  // the pinned frame clips its copy but can still be scrolled from inside (a screen reader asking for the parked
  // headline does exactly that): put the frame back, and take the page to where the headline really is
  el.heroPin.addEventListener('scroll', () => {
    if (!el.heroPin.scrollTop) return;
    el.heroPin.scrollTop = 0;
    if (!RM && !M.hero.flat && S.hero > 0.03) scrollTo({ top: 0, behavior: 'instant' });
  }, { passive: true });

  // the hero at rest, with nothing the scroll wrote left on it: used when it is laid out flat
  function heroRest() {
    for (const n of [el.heroIn, el.heroTitle, el.heroFilm]) { n.style.transform = ''; n.style.transformOrigin = ''; n.style.willChange = ''; }
    el.heroCue.style.visibility = '';
    el.heroProof.style.opacity = '';
    el.heroPin.style.removeProperty('--veil');
    el.heroProofs.forEach(li => { if (li._road && li._road.phase !== 'set') roadSet(li._road); else li.classList.add('on'); });
    S.hero = 0;
    intro.done = true;
    if (scenes.hero) scenes.hero.draw(0);
  }

  function measure() {
    M.vh = innerHeight;
    M.vw = innerWidth;
    M.desk = mqDesk.matches;
    M.announce = el.announce.offsetHeight;
    // categories: runway = viewport + horizontal overflow (desktop only)
    const pinCats = M.desk && !RM;
    if (pinCats) {
      const over = Math.max(0, el.catsTrack.scrollWidth - M.vw);
      el.cats.style.height = M.vh + over + 'px';
      M.cats = { over, cards: el.catCards.map(c => ({ img: $('img', c), cx: c.offsetLeft + c.offsetWidth / 2 })) };
    } else {
      el.cats.style.height = '';
      el.catsTrack.style.transform = '';
      M.cats = null;
    }
    // The hero is pinned for the scroll only when its copy fits the frame. On a short window (a phone on its
    // side, a zoomed laptop, a long translation) what does not fit would leave through the top and be cut, so
    // there the hero is laid out flat, as it is with motion reduced: measured in the pinned layout, then decided.
    root.classList.remove('hero-flat');
    const heroTop = docTop(el.hero);
    el.hero.style.setProperty('--lead', heroTop + 'px');
    const heroRoom = parseFloat(getComputedStyle(el.heroIn).paddingTop) - header.offsetHeight;   // how far the copy may rise before it is under the header
    const heroFlat = !RM && el.heroIn.offsetHeight - el.heroPin.clientHeight > Math.max(0, heroRoom) + 2;
    root.classList.toggle('hero-flat', heroFlat);
    if (heroFlat && !(M.hero && M.hero.flat)) heroRest();
    M.hero = { top: heroTop, len: Math.max(1, el.hero.offsetHeight - el.heroPin.offsetHeight), inH: el.heroIn.offsetHeight, h1H: el.heroTitle.offsetHeight, flat: heroFlat };
    M.size = { top: docTop(el.size), len: Math.max(1, el.size.offsetHeight - el.sizePin.offsetHeight) };
    // short screens: copy taller than the pinned frame scrolls inside it instead of being cut off
    const pin = getComputedStyle(el.sizePin);
    const room = el.sizePin.clientHeight - parseFloat(pin.paddingTop) - parseFloat(pin.paddingBottom);
    el.sizePin.style.setProperty('--size-room', room + 'px');
    el.explain.classList.remove('is-tight');
    el.explain.classList.toggle('is-tight', !RM && el.explain.offsetHeight > room + 1);
    if (M.cats) M.cats.top = docTop(el.cats);
    M.net = { top: docTop(el.net), len: Math.max(1, el.net.offsetHeight - el.netPin.offsetHeight) };
    M.gal = { top: docTop(el.gallery), h: el.gallery.offsetHeight };
    M.rev = { top: docTop(el.cards[0]), bottom: docTop(el.cards[el.cards.length - 1]) + M.vh };
    M.grip = { top: docTop(el.consult), h: el.consult.offsetHeight };
    M.plate = { top: docTop(el.plateWrap) };
    M.stickyTop = parseFloat(getComputedStyle(el.cards[0]).top) || 90;
    M.cardGap = el.cards.length > 1 ? (parseFloat(getComputedStyle(el.cards[1]).top) || 106) - M.stickyTop : 16;
    // road lettering, reads first: where everything still to be laid sits, how much empty road lies above each
    // heading (it stands long up into that and never over anything), and how many lines each paragraph runs to
    const laid = road.waiting.map(it => {
      const r = it.el.getBoundingClientRect();
      if (!ROAD_HEADS[it.kind]) return { it, top: r.top + scrollY, n: it.kind === 'lane' ? Math.max(1, Math.round(r.height / (parseFloat(getComputedStyle(it.el).lineHeight) || 27))) : 1 };
      const sec = it.el.closest('section'), prev = sec && sec.previousElementSibling;
      const lead = it.cap ? it.cap.getBoundingClientRect().top : r.top;
      // a section that clips (a pinned frame, the consult band) gives only its own room: lettering that stood up
      // into the section before would be cut flat at the edge
      const open = sec && getComputedStyle(sec).overflowY === 'visible';
      const above = (sec ? lead - sec.getBoundingClientRect().top : 0) + (prev && open ? Math.min(140, parseFloat(getComputedStyle(prev).paddingBottom) || 0) : 0);
      return { it, bottom: r.bottom + scrollY, h: r.height, above };
    });
    // then the writes. enter: the line that has to come over the bottom edge for it to start. ref: where it is read.
    laid.forEach(({ it, top, n, bottom, h, above }) => {
      if (!ROAD_HEADS[it.kind]) {
        it.enter = it.ref = top;
        if (it.kind === 'lane') { it.n = n; it.el.style.animationDuration = (n * 0.06).toFixed(2) + 's'; it.el.style.animationTimingFunction = `steps(${n}, end)`; }
        return;
      }
      it.bottom = it.ref = bottom;
      it.h = h;
      // only carriageway paint stands long; the other headings keep to their own height
      it.L0 = it.kind === 'word' ? Math.max(1.25, Math.min(3, 1 + (above - 14) / Math.max(1, h))) : 1;
      it.enter = bottom - it.L0 * h;
    });
    // what covers the bottom edge of the screen: the dock on phones, the trip meter on wide screens
    M.roadClear = M.desk ? 64 : el.dock.offsetHeight + 6;
    M.docLen = Math.max(1, document.documentElement.scrollHeight - M.vh);
    mq.cycle = (track.scrollWidth + parseFloat(getComputedStyle(track).columnGap || 16)) / 3;
    Object.values(scenes).forEach(s => s.resize());
  }

  function update(sy, dt) {
    const vh = M.vh;
    const vel = sy - lastY;

    // header tucks away going down, drops back going up
    if (!header.contains(document.activeElement)) {
      if (sy < M.announce + 160 || vel < -4) header.classList.remove('is-hidden');
      else if (vel > 4) header.classList.add('is-hidden');
    } else header.classList.remove('is-hidden');

    // phone dock appears once the sidewall sequence is over
    const dockOn = sy > M.size.top + M.size.len - 4;
    if (!RM) { el.dock.classList.toggle('is-on', dockOn); el.dock.inert = !dockOn && !M.desk; }

    if (RM) return;

    // how long the page has stood still: what finishes anything a visitor has stopped in front of
    road.still = Math.abs(vel) < 0.5 ? road.still + dt : 0;

    // road lettering: paint on its way from as laid to as read
    if (road.on) {
      const far = Math.abs(vel) / vh;                      // screens travelled this frame
      if (road.hero.length && !root.classList.contains('is-loading')) { road.hero.forEach(roadStart); road.hero.length = 0; }
      if (dt > 0 && far > 8 * dt) {
        // faster than eight screens a second nobody is reading: a jump or a hard flick lands on finished paint,
        // and whatever it skipped is behind the visitor and finished too
        road.flew = Math.max(road.flew, 0.3);
        road.live.forEach(it => { if (it.kind !== 'proof') roadSet(it); });
        road.waiting = road.waiting.filter(it => { if (it.ref > sy + vh * 0.5) return true; roadSet(it); return false; });
      } else {
        road.flew = Math.max(0, road.flew - dt);
        // everything still ahead starts the moment it comes over the bottom edge (for a heading, its far end)
        for (let i = road.waiting.length - 1; i >= 0; i--) {
          const it = road.waiting[i];
          if (sy + vh <= it.enter) continue;
          road.waiting.splice(i, 1);
          // first met high on the screen (came back up the page, or landed here): finished paint, no show
          if (road.flew > 0 || it.ref < sy + vh * 0.5) roadSet(it); else roadStart(it);
        }
        const still = road.still > 0.1;
        road.live.forEach(it => roadStep(it, dt, far, still, sy, vh));
      }
    }

    // trip meter: page progress on three drums
    const trip = Math.round(clamp01(sy / M.docLen) * 100);
    if (trip !== lastTrip) {
      lastTrip = trip;
      const d = String(trip).padStart(3, '0');
      el.odoDigits.forEach((drum, i) => drum.style.setProperty('--n', d[i]));
    }
    el.odo.classList.toggle('is-on', sy > 240 && sy + vh < M.plate.top + 60);
    // lane rail: how far down the road the page is
    if (el.rail) el.rail.style.setProperty('--prog', clamp01(sy / M.docLen).toFixed(4));
    // the badge rim rolls at a true rolling ratio: one turn per circumference of page travelled
    if (el.rim) {
      S.roll = damp(S.roll, (sy * 360) / (Math.PI * 56), dt, 12);
      el.rim.style.transform = `rotate(${S.roll.toFixed(2)}deg)`;
    }

    // hero: the scroll scrubs the film. The headline leaves as the camera goes in, the three promises come
    // up over the tread one by one, and the pin lets go once the clip has run.
    const heroT = clamp01((sy - M.hero.top) / M.hero.len);
    const heroIn = sy < M.hero.top + M.hero.len + vh;
    let introP = 0;
    if (!intro.done) {
      const now = performance.now();
      if (!intro.at && !document.documentElement.classList.contains('is-loading')) {
        intro.at = now;
        if (sy > 4 || !scenes.hero.ready(Math.ceil(intro.from * (HERO_FRAMES - 1)) + 2)) intro.done = true;
      }
      if (intro.at && !intro.done) {
        const t = (now - intro.at) / intro.ms;
        if (t >= 1) intro.done = true; else introP = intro.from * (1 - easeOut(t));
      }
    }
    if (heroCut.stale && scenes.hero && sy < M.hero.top + M.hero.len + 2 * vh) { heroCut.stale = false; scenes.hero.swap(heroCfg()); }
    if (M.hero.flat) {
      // laid out flat: nothing here is driven by the scroll
    } else if (heroIn || S.hero !== heroT || introP) {
      const p = S.hero = heroIn ? damp(S.hero, heroT, dt) : heroT;
      // the headline is paint on the road in front of the camera: as the camera goes in it runs long and
      // passes underneath, out through the bottom edge. Nothing fades.
      const out = range(p, 0.03, 0.22);
      if (out > 0 && road.heroBusy) { road.heroBusy = false; road.hero.length = 0; road.items.forEach(it => { if (it.hero && it.phase !== 'set') roadSet(it); }); }
      // (the buttons stay live for as long as any of them shows: once the block is out, the frame clips it)
      // (on one column the headline stands up from its bottom edge, so the block travels that much further:
      // its far end leaves the frame with the rest)
      el.heroIn.style.transform = out > 0 ? `translate3d(0,${(out * out * (M.hero.inH + (M.desk ? 0 : 1.4 * M.hero.h1H))).toFixed(1)}px,0)` : '';
      if (out > 0) {
        // on one column the lede sits right under the headline, so there it runs long upward into the picture;
        // beside the copy it runs long downward. It is its own layer for the length of the leave and no longer.
        if (!el.heroTitle.style.transformOrigin) { el.heroTitle.style.transformOrigin = M.desk ? '0 0' : '0 100%'; el.heroTitle.style.willChange = 'transform'; }
        el.heroTitle.style.transform = `scaleY(${(1 + 1.4 * out).toFixed(3)})`;
      } else if (el.heroTitle.style.transformOrigin) { el.heroTitle.style.transformOrigin = ''; el.heroTitle.style.transform = ''; el.heroTitle.style.willChange = ''; }
      el.heroCue.style.visibility = p > 0.012 ? 'hidden' : '';
      // the three promises are laid where the headline was, and the distance finishes them one by one
      el.heroProof.style.opacity = p >= 0.25 ? '1' : '0';
      el.heroPin.style.setProperty('--veil', range(p, 0.2, 0.3).toFixed(3));
      // A promise is finished by the distance, or by the clock when the visitor stands still (one after another,
      // each when the one before is done), and once finished it stays finished for as long as the list shows.
      const shown = p >= 0.25;
      let turn = true;
      el.heroProofs.forEach((li, i) => {
        const it = road.on ? li._road : null;
        const begun = it ? it.phase !== 'wait' : li.classList.contains('on');
        const want = shown && (begun || p > 0.34 + i * 0.15 || (turn && road.still > 0.5));
        if (!it) li.classList.toggle('on', want);
        else if (want && !begun) roadStart(it);
        else if (!want && begun) roadRaw(it);
        turn = it ? it.phase === 'set' : li.classList.contains('on');
      });
      // leaving: the frame drifts down a little as the next section takes over
      const xp = clamp01((sy - M.hero.top - M.hero.len) / vh);
      el.heroFilm.style.transform = xp > 0 ? `translate3d(0,${(xp * 12).toFixed(2)}%,0)` : '';
      // at rest the picture settles onto one whole frame instead of standing as a mix of two
      const film = Math.max(range(p, 0, 0.96), introP);
      S.film = road.still > 0.12 && !introP ? damp(S.film, Math.round(film * (HERO_FRAMES - 1)) / (HERO_FRAMES - 1), dt, 14) : film;
      scenes.hero.draw(S.film);
    }

    // sidewall: the size is read off the still tyre, one measurement at a time
    const sizeT = clamp01((sy - M.size.top) / M.size.len);
    const sizeIn = sy > M.size.top - vh && sy < M.size.top + M.size.len + vh;
    // outside its window the sequence settles on its end state once, so it is never left half way
    if (sizeIn || S.size !== sizeT) {
      const enter = easeOut(clamp01((sy + vh - M.size.top) / vh));
      const p = S.size = sizeIn ? damp(S.size, sizeT, dt) : sizeT;
      const dp = { w: range(p, 0.06, 0.24), p: range(p, 0.3, 0.48), r: range(p, 0.54, 0.72) };
      dimKeys.forEach(k => {
        const v = easeOut(dp[k]);
        dimEls[k].forEach(n => { n.style.setProperty('--dp', v.toFixed(3)); n.classList.toggle('on', v > 0.5); });
      });
      el.stageIn.style.transform = `translate3d(0,${((1 - enter) * 10 - 2 * p).toFixed(2)}%,0) scale(${(0.9 + 0.1 * enter + 0.05 * p).toFixed(4)})`;
      el.stageIn.style.opacity = (0.2 + 0.8 * enter).toFixed(3);
    }

    // categories: vertical scroll pans the row
    if (M.cats && sy > M.cats.top - vh && sy < M.cats.top + M.cats.over + vh) {
      const p = S.cats = damp(S.cats, clamp01((sy - M.cats.top) / (M.cats.over || 1)), dt);
      const shift = p * M.cats.over;
      el.catsTrack.style.transform = `translate3d(${-shift}px,0,0)`;
      el.catsBar.style.setProperty('--p', p.toFixed(4));
      M.cats.cards.forEach(c => {
        const off = Math.max(-1.4, Math.min(1.4, (c.cx - shift - M.vw / 2) / (M.vw / 2)));
        c.img.style.transform = `translate3d(${off * -18}px,0,0) scale(1.12)`;
      });
    }

    // network: fly down the highway, raise the milestones, paint the route
    if (sy > M.net.top - vh && sy < M.net.top + M.net.len + vh) {
      const p = S.net = damp(S.net, clamp01((sy - M.net.top) / M.net.len), dt);
      scenes.net.draw(clamp01((sy + vh * 0.6 - M.net.top) / (M.net.len + vh * 0.6)));
      el.stones.forEach((stone, i) => {
        if (p > 0.06 + i * 0.085 && !stone.classList.contains('in')) {
          stone.classList.add('in');
          countUp($('[data-count]', stone));
        }
      });
      const rp = range(p, 0.3, 0.92);
      el.routeLine.style.setProperty('--p', rp.toFixed(4));
      el.stops.forEach((stop, i) => stop.classList.toggle('on', rp >= i / 6 - 0.001 && p > 0.28));
    }

    // chevron board rolls with the page
    el.chevrons.style.transform = `translate3d(${-((sy * 0.14) % 60)}px,0,0)`;

    // gallery columns drift at different speeds
    if (M.desk && sy > M.gal.top - vh && sy < M.gal.top + M.gal.h) {
      const rel = sy + vh / 2 - (M.gal.top + M.gal.h / 2);
      el.gcols.forEach(col => { col.style.transform = `translate3d(0,${rel * +col.dataset.speed}px,0)`; });
    }

    // reviews: covered boards settle back
    if (sy > M.rev.top - vh && sy < M.rev.bottom) {
      el.cards.forEach((card, i) => {
        if (i === el.cards.length - 1) return;
        const nextTop = el.cards[i + 1].getBoundingClientRect().top;
        const cover = clamp01(1 - (nextTop - (M.stickyTop + i * M.cardGap)) / (vh * 0.7));
        card.style.transform = `scale(${1 - cover * 0.045})`;
        card.style.setProperty('--veil', (cover * 0.5).toFixed(3));
      });
    }

    // consult: the wet-tread clip plays while the band crosses the screen
    if (sy > M.grip.top - vh && sy < M.grip.top + M.grip.h) {
      scenes.grip.draw(clamp01((sy + vh - M.grip.top) / (M.grip.h + vh)));
    }

    // closing plate rises out of the page edge
    if (sy + vh > M.plate.top) {
      const travel = Math.min(vh * 0.5, M.docLen + vh - M.plate.top);
      const pp = easeOut(clamp01((sy + vh - M.plate.top) / travel));
      el.plate.style.transform = `translate3d(0,${lerp(58, 0, pp)}%,0)`;
      if (pp > 0.8) el.plate.classList.add('is-stamped');
    }

    // marquee: steady drift, leans into scroll velocity
    if (mq.visible && mq.cycle) {
      mq.skew = lerp(mq.skew, Math.max(-10, Math.min(10, vel * 0.35)), 0.1);
      if (!mq.paused && !mq.hover) {
        mq.x -= dt * 62 + Math.abs(vel) * 0.3;
        if (-mq.x > mq.cycle) mq.x += mq.cycle;
      }
      track.style.transform = `translate3d(${mq.x}px,0,0) skewX(${(mq.paused ? 0 : mq.skew).toFixed(2)}deg)`;
    }
  }

  function loop(now) {
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    update(scrollY, dt);
    lastY = scrollY;
    first = false;
    requestAnimationFrame(loop);
  }

  let resizeRaf = 0;
  addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => { measure(); first = true; }); }, { passive: true });
  addEventListener('load', measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  mqDesk.addEventListener('change', measure);
  // the page changes height without the window changing size (an answer opens, a tab swaps): measure again
  if ('ResizeObserver' in window) {
    let tall = document.documentElement.scrollHeight, again = 0;
    new ResizeObserver(() => {
      const now = document.documentElement.scrollHeight;
      if (now === tall) return;
      tall = now;
      cancelAnimationFrame(again);
      again = requestAnimationFrame(measure);
    }).observe(document.body);
  }
  measure();
  roadArm();
  update(scrollY, 0);
  requestAnimationFrame(loop);

  // debug hook: drive effects headlessly, swap frame sequences. step() is one frame of the loop at a chosen
  // scroll position and frame time, for a page whose own loop is not running (a hidden tab, a test)
  window.__fx = { update, measure, M, S, scenes, intro, road, step: (sy, dt) => { update(sy, dt); lastY = sy; first = false; } };
})();
