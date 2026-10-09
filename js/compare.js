/* Compare tyres: the shop's list from config/tyres.json, narrowed to a size or a kind of vehicle when the
   finder sends people here, and up to three tyres read side by side in plain words. */
(function () {
  'use strict';
  const { $, h, icon, fill, plate, fmt, api } = window.HTA;
  const WA = 'https://wa.me/918303400005';
  const SHOP = 'https://hindustantyreagencies.com';
  const KINDS = { car: 'Car and SUV tyres', 'two-wheeler': 'Scooter and bike tyres', truck: 'Truck and bus tyres', tractor: 'Tractor tyres', erickshaw: 'E-rickshaw tyres' };
  const WORDS = {
    wetGrip: ['Low', 'Basic', 'Fair', 'Good', 'Excellent'],
    noise: ['Very loud', 'Loud', 'Average', 'Quiet', 'Very quiet'],
    comfort: ['Hard', 'Firm', 'Average', 'Soft', 'Very soft'],
  };
  const YEARLY_KM = 12000;   // a fair figure for a car in Ludhiana, used only to turn kilometres into years

  const params = new URLSearchParams(location.search);
  const sizeKey = s => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/^(\d+\/\d+)\/(\d+)$/, '$1R$2');
  const wantedSize = params.get('size') ? params.get('size').trim().toUpperCase() : null;
  const wantedType = params.get('type') && Object.prototype.hasOwnProperty.call(KINDS, params.get('type')) ? params.get('type') : null;

  const picked = [];
  let all = [];

  const dots = n => h('span.dots5', { 'aria-hidden': 'true' }, ...[1, 2, 3, 4, 5].map(i => h('i' + (i <= n ? '.on' : ''))));
  const years = km => { const y = km / YEARLY_KM; return y >= 1.5 ? `about ${Math.round(y)} years at ${fmt.n(YEARLY_KM)} km a year` : `about ${Math.round(y * 12)} months at ${fmt.n(YEARLY_KM)} km a year`; };
  const rupees = t => (t.priceFrom == null ? null : `Rs ${fmt.n(t.priceFrom)}`);

  function drawPicks() {
    const list = all.filter(t => (!wantedType || t.type === wantedType) && (!wantedSize || t.sizeKeys.includes(sizeKey(wantedSize))));
    const shown = list.length ? list : all.filter(t => !wantedType || t.type === wantedType);
    $('#pick-title').textContent = wantedSize ? `Tyres in ${wantedSize}` : wantedType ? KINDS[wantedType] : 'All tyres';
    $('#pick-lede').textContent = list.length
      ? `Tap two or three to see them side by side. ${shown.length} ${shown.length === 1 ? 'tyre' : 'tyres'} on the list.`
      : wantedSize ? `Nothing on the list is marked for ${wantedSize} yet. Here is everything of that kind; ask us on WhatsApp for your size.` : 'Tap two or three to see them side by side.';
    if (!shown.length) { fill($('#picks'), h('p.empty', 'Nothing of that kind is on the list yet. Ask us on WhatsApp and we will compare for you.')); fill($('#pick-count')); return; }
    fill($('#picks'), ...shown.map(t => {
      const el = plate(t.name, { kind: 'w', icon: 'tire', 'aria-pressed': String(picked.includes(t.id)), 'data-id': t.id, onclick: () => toggle(t.id) });
      $('.plate-txt', el).prepend(h('small', t.brand));
      return el;
    }));
    const n = picked.length;
    fill($('#pick-count'),
      h('span.chip' + (n ? '.chip-on' : ''), n ? `${n} picked` : 'None picked'),
      n ? h('button.text-link', { type: 'button', onclick: () => { picked.length = 0; drawPicks(); drawBoard(); } }, 'Clear') : null,
      n === 1 ? h('span.muted', 'Pick one more to compare.') : n >= 3 ? h('span.muted', 'Three is the most that fit. Remove one to add another.') : null);
  }
  function toggle(id) {
    const at = picked.indexOf(id);
    if (at >= 0) picked.splice(at, 1);
    else if (picked.length < 3) picked.push(id);
    else return;
    drawPicks();
    drawBoard();
    // a column removed from under the finger: focus moves to that tyre's pick plate
    if (at >= 0) { const back = [...document.querySelectorAll('#picks .plate')].find(p => p.dataset.id === id); if (back) back.focus({ preventScroll: true }); }
  }

  function drawBoard() {
    const board = $('#board'), sign = $('#board-sign');
    const tyres = picked.map(id => all.find(t => t.id === id)).filter(Boolean);
    sign.hidden = tyres.length < 2;
    if (tyres.length < 2) return fill(board);
    const best = (key, pick) => { const vals = tyres.map(t => t[key]).filter(v => v != null); if (vals.length < 2) return null; const b = pick(vals); return vals.filter(v => v === b).length === 1 ? b : null; };
    const bestPrice = best('priceFrom', v => Math.min(...v)), bestLife = best('treadLifeKm', v => Math.max(...v)), bestGrip = best('wetGrip', v => Math.max(...v)), bestQuiet = best('noise', v => Math.max(...v)), bestSoft = best('comfort', v => Math.max(...v)), bestWarranty = best('warrantyMonths', v => Math.max(...v));
    const row = (label, value, small, isBest, words) => h('div.crow' + (isBest ? '.is-best' : ''), h('dt', label, isBest ? h('span.best', 'Best') : null), h('dd' + (words ? '.words' : ''), value, small ? h('small', small) : null));
    board.style.setProperty('--n', String(tyres.length));
    fill(board, ...tyres.map(t => h('div.ccol',
      h('div.chead',
        h('span.brand', t.brand), h('span.model', t.name),
        h('span.sizes', wantedSize && t.sizeKeys.includes(sizeKey(wantedSize)) ? `Comes in ${wantedSize}` : `Sizes: ${t.sizes.slice(0, 4).join(', ')}${t.sizes.length > 4 ? ' and more' : ''}`),
        h('button.roundel.unpick', { type: 'button', 'aria-label': `Remove ${t.brand} ${t.name} from the comparison`, onclick: () => toggle(t.id) }, icon('x'))),
      h('dl',
        row('Price from', rupees(t) || 'Ask us', rupees(t) ? 'per tyre, fitting extra' : 'WhatsApp for today\'s price', t.priceFrom != null && t.priceFrom === bestPrice),
        row('Warranty', t.warrantyMonths ? `${t.warrantyMonths} months` : 'None listed', t.warrantyMonths ? `${Math.round(t.warrantyMonths / 12)} years against manufacturing defects` : null, t.warrantyMonths === bestWarranty),
        row('Tread life', t.treadLifeKm ? fmt.km(t.treadLifeKm) : 'Depends on use', t.treadLifeKm ? years(t.treadLifeKm) : 'Ask us about your kind of driving', t.treadLifeKm != null && t.treadLifeKm === bestLife),
        row('Wet grip', h('span', WORDS.wetGrip[t.wetGrip - 1], dots(t.wetGrip)), null, t.wetGrip === bestGrip, true),
        row('Noise', h('span', WORDS.noise[t.noise - 1], dots(t.noise)), null, t.noise === bestQuiet, true),
        row('Comfort', h('span', WORDS.comfort[t.comfort - 1], dots(t.comfort)), null, t.comfort === bestSoft, true),
        row('Best for', t.bestFor, t.notes, false, true)),
      h('div.cact',
        plate('Ask about this one', { icon: 'whatsapp-logo', href: `${WA}?text=${encodeURIComponent(`Hello Hindustan Tyre. Price today for ${t.brand} ${t.name}${wantedSize ? ' in ' + wantedSize : ''}?`)}` }),
        plate('See it in the shop', { kind: 'w', icon: 'arrow-right', href: `${SHOP}/search?q=${encodeURIComponent(t.brand + ' ' + t.name)}&ref=compare`, target: '_blank', rel: 'noopener' })))));
    sign.scrollIntoView({ block: 'start', behavior: document.documentElement.classList.contains('rm') ? 'auto' : 'smooth' });
  }

  async function load() {
    let data;
    try { data = await api('/api/public/tyres'); } catch (e) {
      return fill($('#picks'), h('p.status.is-bad', 'The tyre list could not be loaded. WhatsApp us on 83034 00005 and we will compare for you.'));
    }
    all = data.tyres;
    $('#sample').hidden = !data.sample;
    const first = (params.get('pick') || '').split(',').filter(Boolean).slice(0, 3);
    for (const id of first) if (all.some(t => t.id === id)) picked.push(id);
    drawPicks();
    drawBoard();
    const back = $('#back-finder');
    back.href = wantedType ? '/tyres/#/' + (wantedType === 'two-wheeler' ? 'scooter' : wantedType) : '/tyres/';
  }
  load();
})();
