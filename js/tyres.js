/* Find my tyres: one question per screen, no typing. Every answer is a number plate; the last screen reads the
   pick back and hands over to the shop's own collection page, or to WhatsApp when nobody is sure. */
(function () {
  'use strict';
  const { $, $$, h, icon, fill, plate, show } = window.HTA;
  const DATA = window.HTA_DATA || { vehicles: {}, sizes: [] };
  const BASE = 'https://hindustantyreagencies.com';
  const WA = 'https://wa.me/918303400005';
  const RM = document.documentElement.classList.contains('rm');

  /* ---------- the same spelling and link rules as the home page finder ---------- */
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const MAKE_LABELS = { bmw: 'BMW', mg: 'MG', byd: 'BYD', range: 'Range Rover', 'mercedes-benz': 'Mercedes Benz' };
  // full vehicle names where the slug rules get it wrong (the store files Range Rover as make "range", model "rover")
  const MODEL_LABELS = { 'range/rover': 'Range Rover', 'range/rover-sport': 'Range Rover Sport', 'maruti-suzuki/wagonr': 'Maruti Suzuki WagonR', 'isuzu/mu-x': 'Isuzu MU-X', 'mg/zs-ev': 'MG ZS EV' };
  const ACRONYMS = ['ev', 'gt', 'gti', 'amg', 'g', 'suv', 'xuv', 'kuv', 'tuv', 'xl', 'zx', 'glc', 'gle', 'gls', 'gla', 'glb', 'zs', 'mu', 'cls', 'cla'];
  const prettyToken = w => {
    if (!w) return w;
    if (ACRONYMS.includes(w)) return w.toUpperCase();
    if (/^[a-z]+\d/.test(w) || /^\d+[a-z]+$/.test(w) || /^[a-z]$/.test(w) || /^\d+$/.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  const pretty = s => (own(MAKE_LABELS, s) ? MAKE_LABELS[s] : s.split('-').map(prettyToken).join(' '));
  const vehicleName = (make, model) => (own(MODEL_LABELS, `${make}/${model}`) ? MODEL_LABELS[`${make}/${model}`] : `${pretty(make)} ${pretty(model)}`);
  // on the model screen the company is already in the heading
  const modelName = (make, model) => { const full = vehicleName(make, model), mk = pretty(make) + ' '; return full.startsWith(mk) ? full.slice(mk.length) : full; };
  const slug = v => String(v || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ref = url => url + (url.includes('?') ? '&' : '?') + 'ref=tyres';
  const tagUrl = tags => ref(`${BASE}/collections/all/${tags.join('+')}`);
  const col = handle => ref(`${BASE}/collections/${handle}`);
  const wa = text => `${WA}?text=${encodeURIComponent(text)}`;

  // size tags as the shop files them. Lookups go by a key that drops the gap before a letter, so "150/80 B16" as a
  // person writes it and "150/80b16" as the store files it meet at 150-80b16, which is also the store's own handle.
  const key = s => slug(s).replace(/-(?=[rdb]\d+$)/, '');
  const byHandle = new Map();
  for (const t of DATA.sizes) byHandle.set(key(t), t);
  const tagFor = written => byHandle.get(key(written)) || byHandle.get(key(written.replace('-', '.'))) || null;
  // "185/65/15" is printed on the tyre as 185/65 R15; a dotted tag such as 12.4.28 is printed 12.4-28
  const printed = tag => {
    if (/^\d{3}\/\d{2}\/\d{2}$/.test(tag)) return tag.replace(/^(\d+)\/(\d+)\/(\d+)$/, '$1/$2 R$3');
    if (/^\d+\.\d+\.\d+$/.test(tag)) return tag.replace(/^(\d+\.\d+)\.(\d+)$/, '$1-$2');
    return tag.replace(/^(\d+\/\d+)([rdb])(\d+)$/i, (m, a, l, b) => `${a} ${l.toUpperCase()}${b}`);
  };

  const TYPES = {
    car: { name: 'Car or SUV', collection: 'car-tyre' },
    scooter: { name: 'Scooter', collection: 'scooter-tyre', example: '90/90-12', groups: [{ sizes: ['90/90-12', '90/100-10', '110/80-12', '3.00-10', '3.50-10'] }] },
    motorcycle: { name: 'Motorcycle', collection: 'motor-cycle', example: '90/90-18', groups: [{ sizes: ['2.50-16', '2.75-17', '2.75-18', '3.00-17', '3.00-18', '3.25-16', '3.25-19', '3.50-19', '80/100-17', '80/100-18', '90/90-17', '90/90-18', '90/90-19', '100/90-17', '110/80-17', '110/90-18', '120/80-17', '120/80-18', '140/70-17', '150/80 B16'] }] },
    truck: { name: 'Truck or Bus', collection: 'truck-tyre', example: '10.00-20', groups: [{ sizes: ['6.00-14', '6.00-16', '6.50-16', '6.50-20', '7.50-16', '7.50-20', '9.00-16', '10.00-16', '10.00-20', '11.00-16', '11.00-20'] }] },
    tractor: { name: 'Tractor', collection: 'tractor-tyre', example: '13.6-28', groups: [
      { kicker: 'Back wheel', sizes: ['12.4-24', '12.4-28', '13.6-28', '14.9-28', '15.9-28', '16.9-28', '16.9-30', '18.4-30', '13.00-24', '14.00-25', '308/85 R28', '320/85 R28', '340/85 R28', '380/85 R28', '420/85 R28'] },
      { kicker: 'Front wheel', sizes: ['6.00-16', '6.50-16', '7.50-16', '9.00-16'] }] },
    erickshaw: { name: 'E Rickshaw', collection: 'e-riksha', example: '3.75-12', groups: [{ sizes: ['3.75-12', '4.00-8', '4.00-10', '4.00-12', '4.50-10'] }] },
  };
  const TOP_MAKES = ['maruti-suzuki', 'hyundai', 'mahindra', 'tata', 'toyota', 'honda'];
  // tyre brands (js/data.js, compiled from the store by tools/make-brand-list.js). The store's search is asked for
  // the brand's name in the product title, and for the store's own tag when a kind of vehicle is picked too.
  const BRANDS = Array.isArray(DATA.brands) ? DATA.brands.filter(b => b && /^[a-z]+$/.test(b.id) && Array.isArray(b.words) && Array.isArray(b.types)) : [];
  const TOP_BRANDS = 4;
  const TYPE_TAGS = DATA.brandTypeTags || {};   // the store's own tag for each kind of vehicle
  const TYPE_PICS = { car: 'car', scooter: 'scooter', motorcycle: 'motorcycle', tractor: 'farm', truck: 'truck', erickshaw: 'erickshaw' };
  const brandUrl = (B, type) => ref(BASE + '/search?type=product&q=' + encodeURIComponent([...B.words.map(w => 'title:' + w), ...(type && own(TYPE_TAGS, type) ? ['tag:' + JSON.stringify(TYPE_TAGS[type])] : [])].join(' ')));
  // "car or SUV", "truck or bus": a kind of vehicle inside a sentence
  const said = T => T.name.toLowerCase().replace('suv', 'SUV');
  const carTags = DATA.sizes.filter(t => /^\d{3}\/\d{2}\/\d{2}$/.test(t) || /^\d{3}\/\d{2}d\d{2}$/i.test(t));
  const rimOf = t => t.match(/(\d{2})$/)[1];
  const rims = [...new Set(carTags.map(rimOf))].sort((a, b) => a - b);

  /* ---------- small helpers ---------- */
  const tab = name => h('span.plate-tab', { 'aria-hidden': 'true' }, icon(name));
  // a plate that is a link to the next step, or out to the shop
  const answer = (label, href, { kind, iconName, mini } = {}) => {
    const el = h('a', { class: 'plate' + (kind ? ' plate-' + kind : '') + (mini ? ' plate-mini' : ''), href });
    if (iconName) el.append(tab(iconName));
    el.append(h('span.plate-txt', label));
    return el;
  };
  const stagger = box => $$(':scope > *', box).forEach((el, i) => el.style.setProperty('--d', Math.min(i * 0.022, 0.4) + 's'));
  const nav = hash => { location.hash = hash; };
  const parse = () => { try { return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); } catch (e) { return ['?']; } };

  /* ---------- screens ---------- */
  function renderCompany() {
    const makes = Object.keys(DATA.vehicles);
    const top = TOP_MAKES.filter(m => makes.includes(m));
    const rest = makes.filter(m => !top.includes(m)).sort((a, b) => pretty(a).localeCompare(pretty(b)));
    fill($('#company-top'), ...top.map(m => answer(pretty(m), '#/car/' + m, { kind: 'w' })));
    fill($('#company-rest'), ...rest.map(m => answer(pretty(m), '#/car/' + m, { kind: 'w' })));
    stagger($('#company-top'));
    stagger($('#company-rest'));
  }

  function renderModels(make) {
    $('#model-title').replaceChildren('Which ', h('em', pretty(make) + '?'));
    fill($('#model-all'), answer(`Not sure, show all ${pretty(make)} tyres`, tagUrl([`make-${make}`]), { kind: 'k', iconName: 'arrow-right' }));
    $('#model-all .plate').classList.add('plate-block');
    const models = (Array.isArray(DATA.vehicles[make]) ? [...DATA.vehicles[make]] : []).sort((a, b) => modelName(make, a).localeCompare(modelName(make, b)));
    fill($('#models'), ...models.map(m => answer(modelName(make, m), `#/car/${make}/${m}`, { kind: 'w' })));
    stagger($('#models'));
  }

  function renderRims() {
    fill($('#rims'), ...rims.map(r => answer('R' + r, '#/car/size/' + r, { kind: 'w', mini: true })));
    stagger($('#rims'));
  }

  function renderCarSizes(rim) {
    const tags = carTags.filter(t => rimOf(t) === rim).sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
    const seen = new Set();
    const plates = [];
    for (const t of tags) { if (seen.has(slug(t))) continue; seen.add(slug(t)); plates.push(answer(printed(t), `#/car/size/${rim}/${slug(t)}`, { kind: 'w' })); }
    plates.push(answer('My size is not here', wa(`Hello Hindustan Tyre. My car tyre size is not on your list. My size is: `), { kind: 'k', iconName: 'whatsapp-logo' }));
    fill($('#carsizes'), ...plates);
    stagger($('#carsizes'));
  }

  function renderTypeSizes(type) {
    const T = TYPES[type];
    $('#type-example-code').textContent = T.example;
    const parts = [answer(`Show all ${T.name.toLowerCase()} tyres`, col(T.collection), { iconName: 'arrow-right' })];
    parts[0].classList.add('plate-block');
    const seen = new Set();
    for (const group of T.groups) {
      const plates = [];
      for (const written of group.sizes) {
        const tag = tagFor(written);
        if (!tag) { console.warn(`Find my tyres: size "${written}" is not in the shop's size list and is not offered`); continue; }
        if (seen.has(slug(tag))) continue;
        seen.add(slug(tag));
        plates.push(answer(printed(tag), `#/${type}/${slug(tag)}`, { kind: 'w' }));
      }
      if (!plates.length) continue;
      if (group.kicker) parts.push(h('p.kicker', group.kicker));
      const grid = h('div.picks-grid', plates);
      stagger(grid);
      parts.push(grid);
    }
    parts.push(answer('My size is not here', wa(`Hello Hindustan Tyre. My ${T.name.toLowerCase()} tyre size is not on your list. My size is: `), { kind: 'k', iconName: 'whatsapp-logo' }));
    parts[parts.length - 1].classList.add('plate-block');
    fill($('#typesizes'), ...parts);
  }

  // a brand is a tile with its logo on a white plate and its name underneath, for anyone who knows the word but not the badge
  const brandTile = B => h('li', h('a.tile.tile-logo', { href: '#/brand/' + B.id },
    h('span.tile-img', h('img', { src: `/assets/img/brands/${B.id}.webp`, alt: '', loading: 'lazy' })),
    h('span.tile-name', { translate: 'no' }, B.name, icon('arrow-right'))));
  function renderBrands() {
    const top = [...BRANDS].sort((a, b) => b.n - a.n).slice(0, TOP_BRANDS);
    const rest = BRANDS.filter(b => !top.includes(b)).sort((a, b) => a.name.localeCompare(b.name));
    fill($('#brand-top'), ...top.map(brandTile));
    fill($('#brand-rest'), ...rest.map(brandTile));
    stagger($('#brand-top'));
    stagger($('#brand-rest'));
  }
  function renderBrandTypes(B) {
    $('#brandtype-kicker').textContent = `${B.name} tyres`;
    fill($('#brandtypes'), ...B.types.filter(t => own(TYPES, t)).map(t => h('li', h('a.tile.pos-' + t, { href: `#/brand/${B.id}/${t}` },
      h('span.tile-img', h('img', { src: `/assets/img/cat/${TYPE_PICS[t]}.webp`, alt: '', loading: 'lazy' })),
      h('span.tile-name', TYPES[t].name, icon('arrow-right'))))));
    stagger($('#brandtypes'));
    const all = answer('Not sure, show them all', '#/brand/' + B.id + '/all', { kind: 'k', iconName: 'arrow-right' });
    all.classList.add('plate-block');
    fill($('#brandtype-all'), all);
  }

  function renderFound(pick, backHash) {
    $('#found-name').textContent = pick.name;
    $('#found-kind').textContent = pick.kind;
    // one step back is a route of its own, so a link opened cold from WhatsApp can still be changed
    const back = plate('Change something', { kind: 'k', icon: 'arrow-left', onclick: () => nav(backHash) });
    const go = answer('Show me the tyres', pick.url, { iconName: 'arrow-right' });
    go.classList.add('plate-block');
    back.classList.add('plate-block');
    back.style.setProperty('--d', '.06s');
    fill($('#found-actions'), go, back, h('p', h('a.text-link', { href: wa(pick.ask) }, 'Ask us on WhatsApp instead', icon('arrow-right'))));
    offerCompare(pick, go);
  }

  // "Compare" appears after "Show me the tyres" when the shop's list has two or more tyres for this pick
  let tyreList = null;
  async function offerCompare(pick, after) {
    if (!pick.compareType) return;
    try { tyreList = tyreList || (await (await fetch('/api/public/tyres', { cache: 'no-store' })).json()).tyres; } catch (e) { return; }
    const sizeKey = s => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/^(\d+\/\d+)\/(\d+)$/, '$1R$2');
    const match = tyreList.filter(t => t.type === pick.compareType && (!pick.compareSize || t.sizeKeys.includes(sizeKey(pick.compareSize))));
    if (match.length < 2 || !after.isConnected) return;
    const q = new URLSearchParams({ type: pick.compareType });
    if (pick.compareSize) q.set('size', pick.compareSize);
    const cmp = answer(`Compare ${match.length} tyres`, `/compare/?${q}`, { kind: 'w', iconName: 'ruler' });
    cmp.classList.add('plate-block');
    cmp.style.setProperty('--d', '.03s');
    after.after(cmp);
  }

  /* ---------- the route: one hash per step ---------- */
  function resolve() {
    const p = parse();
    if (!p.length) return { view: 'start', step: 1, total: 3, answers: [] };
    if (p[0] === 'brand') {
      const answers = [{ label: 'By brand', hash: '#/' }];
      if (!p[1]) return { view: 'brand', step: 2, total: 3, answers, draw: renderBrands, who: 'but I am not sure which brand' };
      const B = BRANDS.find(b => b.id === p[1]);
      if (!B) return null;
      answers.push({ label: B.name, hash: '#/brand', keep: true });
      const who = `from ${B.name}. I am not sure which one fits`;
      const all = { name: B.name, kind: 'All tyres from this brand', url: brandUrl(B), ask: `Hello Hindustan Tyre. I am looking for ${B.name} tyres.` };
      const types = B.types.filter(t => own(TYPES, t));
      if (!p[2]) return types.length < 2 ? { view: 'found', answers, pick: all, who } : { view: 'brandtype', step: 3, total: 3, answers, draw: () => renderBrandTypes(B), who };
      if (p[2] === 'all' && types.length > 1) return { view: 'found', answers, pick: all, who };
      if (!types.includes(p[2]) || types.length < 2) return null;
      const T = TYPES[p[2]];
      answers.push({ label: T.name, hash: '#/brand/' + B.id });
      return { view: 'found', answers, who, pick: { name: `${B.name} ${T.name}`, kind: `${T.name} tyres`, url: brandUrl(B, p[2]), ask: `Hello Hindustan Tyre. I am looking for ${B.name} tyres for my ${said(T)}.` } };
    }
    if (p[0] === 'car') {
      const answers = [{ label: 'Car or SUV', hash: '#/' }];
      if (p[1] === 'size') {
        answers.push({ label: 'I know my size', hash: '#/car' });
        if (!p[2]) return { view: 'rim', step: 3, total: 4, answers, draw: renderRims };
        if (!rims.includes(p[2])) return null;
        answers.push({ label: 'R' + p[2], hash: '#/car/size' });
        if (!p[3]) return { view: 'carsize', step: 4, total: 4, answers, draw: () => renderCarSizes(p[2]) };
        const tag = carTags.find(t => slug(t) === p[3] && rimOf(t) === p[2]);
        if (!tag) return null;
        return { view: 'found', answers, pick: { name: printed(tag), kind: 'Car or SUV tyres', url: tagUrl([slug(tag)]), ask: `Hello Hindustan Tyre. I need car tyres in size ${printed(tag)}.`, compareType: 'car', compareSize: printed(tag) } };
      }
      if (!p[1]) return { view: 'company', step: 2, total: 3, answers, draw: renderCompany };
      if (!Array.isArray(DATA.vehicles[p[1]])) return null;
      answers.push({ label: pretty(p[1]), hash: '#/car' });
      if (!p[2]) return { view: 'model', step: 3, total: 3, answers, draw: () => renderModels(p[1]) };
      if (!DATA.vehicles[p[1]].includes(p[2])) return null;
      const name = vehicleName(p[1], p[2]);
      return { view: 'found', answers, pick: { name, kind: 'Car or SUV tyres', url: tagUrl([`make-${p[1]}`, `model-${p[1]}-${p[2]}`]), ask: `Hello Hindustan Tyre. I need tyres for my ${name}.`, compareType: 'car' } };
    }
    if (!own(TYPES, p[0]) || !TYPES[p[0]].groups) return null;
    const T = TYPES[p[0]];
    const answers = [{ label: T.name, hash: '#/' }];
    if (!p[1]) return { view: 'typesize', step: 2, total: 2, answers, draw: () => renderTypeSizes(p[0]) };
    const tag = byHandle.get(key(p[1]));
    if (!tag) return null;
    return { view: 'found', answers, pick: { name: `${T.name} ${printed(tag)}`, kind: `${T.name} tyres`, url: tagUrl([slug(tag)]), ask: `Hello Hindustan Tyre. I need ${T.name.toLowerCase()} tyres in size ${printed(tag)}.`, compareType: { scooter: 'two-wheeler', motorcycle: 'two-wheeler', truck: 'truck', tractor: 'tractor', erickshaw: 'erickshaw' }[p[0]] || null, compareSize: printed(tag) } };
  }

  // the help board and the dock speak about where the reader is
  function setHelp(route) {
    const a = route.answers;
    const who = route.who ? route.who : !a.length ? 'but I am not sure which' : a[0].label === 'Car or SUV' ? (a[1] && a[1].label !== 'I know my size' ? `for my ${a[1].label}. I am not sure of the model or size` : 'for my car. I am not sure of the size') : `for my ${a[0].label.toLowerCase()}. I am not sure of the size`;
    const text = `Hello Hindustan Tyre. I need tyres ${who}. Here is a photo of my tyre:`;
    $('#help-wa').href = wa(text);
    $('#dock-wa').href = wa(text);
  }

  let current = null, back = '#/';
  function render() {
    for (const p of $$('.plate.is-pressed')) p.classList.remove('is-pressed');
    // an ordinary in-page anchor (#main from the skip link, #help) is not a step: focus it and leave the journey alone
    const frag = location.hash.slice(1);
    if (frag && !/^\//.test(frag) && document.getElementById(frag)) {
      const t = document.getElementById(frag);
      t.setAttribute('tabindex', '-1');
      t.focus();
      return;
    }
    const route = resolve();
    if (!route) { history.replaceState(null, '', '#/'); return render(); }
    // the owner's counts: how far people get (never what they chose)
    if (window.HTA_STAT) { if (route.view === 'found') window.HTA_STAT('tyres.found'); else if (route.step >= 2) window.HTA_STAT('tyres.step.' + Math.min(route.step, 4)); }
    back = '#/' + parse().slice(0, -1).join('/');
    if (route.draw) route.draw();
    if (route.pick) renderFound(route.pick, back);

    const trail = $('#trail');
    trail.hidden = !route.answers.length;
    fill(trail, ...route.answers.map(x => plate(x.label, { kind: 'w', mini: true, onclick: () => nav(x.hash), 'aria-label': `Change answer: ${x.label}`, translate: x.keep ? 'no' : null })),
      route.answers.length ? h('button.text-link', { type: 'button', onclick: () => nav('#/') }, 'Start again') : null);
    $('#chevrons').style.setProperty('--step', String(route.answers.length));
    $('#step-live').textContent = route.view === 'found' ? 'Found it' : `Step ${route.step} of ${route.total}`;
    setHelp(route);

    const next = show(route.view);
    if (next && current !== route.view) {
      next.classList.remove('view-enter');
      void next.offsetWidth;   // restart the entrance for a screen that was shown before
      next.classList.add('view-enter');
      $$('.sidewall', next).forEach(f => { f.classList.remove('in'); void f.offsetWidth; f.classList.add('in'); });
    }
    if (route.view === 'start') { $('#tiles').classList.remove('is-picking'); $$('#tiles .tile').forEach(t => t.removeAttribute('aria-pressed')); }
    current = route.view;
  }

  // a tile stamps and the others step back before the next question arrives
  $$('#tiles .tile[data-go]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    a.setAttribute('aria-pressed', 'true');
    $('#tiles').classList.add('is-picking');
    setTimeout(() => nav(a.dataset.go), RM ? 0 : 180);
  }));

  // plates press down under a finger or a key, and stamp back up
  const press = (el, on) => el.classList.toggle('is-pressed', on);
  const plateOf = e => (e.target instanceof Element ? e.target.closest('.plate') : null);
  document.addEventListener('pointerdown', e => { const p = plateOf(e); if (p && e.button === 0) press(p, true); });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { for (const p of $$('.plate.is-pressed')) press(p, false); }, true);
  document.addEventListener('keydown', e => { const p = plateOf(e); if (p && (e.key === ' ' || e.key === 'Enter') && !e.repeat) press(p, true); });
  document.addEventListener('keyup', () => { for (const p of $$('.plate.is-pressed')) press(p, false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && current && current !== 'start') nav(back); });
  // the skip link must not change the hash, or it would restart the journey
  $('.skip').addEventListener('click', e => { e.preventDefault(); const m = $('#main'); m.setAttribute('tabindex', '-1'); m.focus(); });

  document.addEventListener('click', e => {
    if (!window.HTA_STAT || !(e.target instanceof Element)) return;
    if (e.target.closest('.handoff a.plate')) window.HTA_STAT('tyres.go');
    else if (e.target.closest('#dock-wa, a[href*="wa.me"]')) window.HTA_STAT('tyres.help');
  });
  addEventListener('hashchange', render);
  addEventListener('pageshow', e => { if (e.persisted) render(); });
  render();
})();
