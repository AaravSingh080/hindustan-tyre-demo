/* The job card: one sale, laid out for the fitter to tick off and sign. Opened from the staff desk with
   ?sale=<id>; the staff session cookie is what lets it load. Nothing on this page sends anything. */
(function () {
  'use strict';
  const { $, h, icon, fill, plate, vplate, fmt, api, config } = window.HTA;

  const main = $('#job');
  const id = new URLSearchParams(location.search).get('sale');
  const note = (text, cta) => fill(main, h('section.sign', h('p', text), cta || null));

  // what a tyre on this kind of vehicle is usually asked for
  const tasksFor = profile => {
    const list = [
      ['Fit and inflate to', 'psi'],
      ['Balance wheels', null],
      ['Torque wheel nuts', 'Nm'],
      ['New valves', null],
    ];
    if (profile === 'car') list.push(['Alignment check', null], ['Nitrogen fill', null]);
    if (profile === 'truck') list.push(['Check rim and lock ring', null], ['Retorque after 50 km', null]);
    list.push(['Old tyres returned to customer', null], ['Pressure checked on spare', null]);
    return list;
  };
  // where the tyres go: a car's four corners, a two wheeler's front and back, otherwise numbered boxes
  const positionsFor = (profile, qty) => {
    if (profile === 'two-wheeler') return qty >= 2 ? ['FRONT', 'REAR'] : ['FRONT or REAR'];
    if (profile === 'car' && qty <= 4) return ['FL', 'FR', 'RL', 'RR'].slice(0, Math.max(qty, 2));
    return Array.from({ length: Math.min(qty, 12) }, (x, i) => String(i + 1));
  };

  async function load() {
    try { await config(); } catch (e) { /* the strip stays hidden */ }
    if (!/^\d{1,12}$/.test(id || '')) return note('Open a job card from the staff desk: register a sale, then press Print job card.', plate('Staff desk', { icon: 'arrow-left', href: '/staff/' }));
    let d;
    try { d = await api(`/api/staff/sales/${id}/job`); } catch (e) {
      if (e.code === 'staff-signed-out') return note('Sign in to the staff desk first, then open the job card again.', plate('Staff desk', { icon: 'lock-key', href: '/staff/' }));
      return note(e.message, plate('Staff desk', { icon: 'arrow-left', href: '/staff/' }));
    }
    const s = d.sale;
    const fact = (label, value, small, span) => h('div' + (span ? '.span2' : ''), h('dt', label), h('dd', value, small ? h('small', small) : null));
    fill(main,
      h('div.job-actions',
        plate('Print', { icon: 'printer', onclick: () => print() }),
        plate('Back to the desk', { kind: 'w', icon: 'arrow-left', href: '/staff/' })),
      h('p.job-note.muted', 'Prints on one A4 sheet. Tick the boxes as the work is done; the customer signs when the tyres are on.'),
      h('article.card', { 'aria-label': `Job card for sale ${s.id}` },
        h('header.card-head',
          h('h1.card-title', h('small', d.shop.name), 'Job card'),
          h('div.card-no', h('span', 'No.'), h('span', String(s.id)))),
        vplate(d.vehicle.regNo),
        h('dl.card-grid',
          fact('Tyre', s.tyre),
          fact('Size', s.size, `${s.qty} ${s.qty === 1 ? 'tyre' : 'tyres'}`),
          fact('Date', fmt.day(s.fittedOn), fmt.clock(s.enteredAt)),
          fact('Odometer', fmt.km(s.odometerKm)),
          fact('Bill no.', s.billNo || 'to be written', s.warrantyMonths ? `Warranty ${s.warrantyMonths} months` : 'No warranty recorded'),
          fact('Customer', `Phone ending ${d.customer.phoneTail}`, s.enteredBy ? `Sale entered by ${s.enteredBy.replace(/^staff:/, '')}` : null)),
        h('h2', 'Fitted at'),
        h('ul.positions', ...positionsFor(d.profile, s.qty).map(p => h('li', p)), s.newTreadMm ? h('li.axle', `New tread ${fmt.mm(s.newTreadMm)}`) : null),
        h('h2', 'Work'),
        h('ul.tasks', ...tasksFor(d.profile).map(([label, unit]) => h('li', label, unit ? h('span.blank') : null, unit ? h('span.unit', unit) : null))),
        h('div.lines', h('div', 'Time in'), h('div', 'Time out'), h('div', 'Fitter'), h('div', 'Customer')),
        h('footer.card-foot',
          h('img', { src: `/api/staff/qr?sale=${s.id}`, alt: 'QR code that opens this tyre passport', width: 108, height: 108 }),
          h('p', h('strong', 'Tyre passport'), `Scan to see these tyres, the warranty and the service history. ${d.shop.name}, ${d.shop.address}. ${fmt.phone(d.shop.phone)}.`))));
    document.title = `Job card ${s.id} | ${d.shop.name}`;
  }
  load();
})();
