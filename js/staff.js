/* Staff desk: unlock with the PIN, register a sale, log a later visit, work through who is due, and see
   breakdowns customers have shared. The server decides everything; this page only asks and shows. */
(function () {
  'use strict';
  const { $, $$, h, icon, fill, plate, vplate, fmt, api, idem, show, fail, clearErrors, busy, say, inPlace, config } = window.HTA;

  const state = { cfg: null, status: null, customer: null, vehicleId: null, saleIdem: idem(), visitIdem: idem(), poll: 0, lookupTimer: 0 };

  // a session that has lapsed or been locked lands back on the PIN screen, wherever it is noticed
  const call = async (path, body, opts) => {
    try { return await api(path, body, opts); } catch (err) { if (err.code === 'staff-signed-out') lock('Locked. Enter the PIN to carry on.'); throw err; }
  };
  const whole = v => (/^\d{1,9}$/.test(v.replace(/[,\s]/g, '')) ? Number(v.replace(/[,\s]/g, '')) : v === '' ? null : NaN);
  const decimal = v => (v === '' ? null : /^\d{1,7}([.,]\d{1,2})?$/.test(v) ? Number(v.replace(',', '.')) : NaN);
  const sign = (title, iconName, ...kids) => h('section.sign', h('h2.sign-title', iconName ? icon(iconName) : null, title), kids);
  const fact = (label, value, small, wide) => [h('dt' + (wide ? '.wide' : ''), label), h('dd' + (wide ? '.wide' : ''), value, small ? h('small', small) : null)];
  const dueLine = e => (e.daysLeft <= 0 ? `Replacement due now (estimated ${fmt.day(e.dueOn)})` : `Replacement around ${fmt.day(e.dueOn)}, ${fmt.days(e.daysLeft)}`);
  const basisLine = e => (e.basis === 'readings' ? `From ${e.readings} readings, last ${fmt.mm(e.lastReadingMm)} on ${fmt.day(e.lastReadingOn)}.`
    : e.lastReadingOn ? `From typical tyre life, held to the ${fmt.mm(e.lastReadingMm)} measured on ${fmt.day(e.lastReadingOn)} (too soon after fitting to show a wear rate).`
      : 'From typical tyre life. No tread reading yet.');

  /* ---------- lock and unlock ---------- */
  const pinForm = $('#pin-form');

  function lock(message) {
    clearInterval(state.poll);
    state.customer = null;
    $('#lock').hidden = true;
    fill($('#customer'));
    show('pin');
    $('#pin').value = '';
    $('.status', pinForm).textContent = message || '';
    if (state.cfg && state.cfg.demo) {
      $('#demo-pin').hidden = false;
      fill($('#demo-pin'), h('p', h('strong', 'Demo. '), `The owner's PIN is ${state.cfg.demo.staffPin}. `, ...(state.cfg.demo.staff || []).map(m => `${m.name} signs in with ${m.pin}. `)));
    }
    $('#pin').focus();
  }

  pinForm.addEventListener('submit', e => {
    e.preventDefault();
    clearErrors(pinForm);
    const pin = $('#pin').value.trim();
    if (!/^\d{4,12}$/.test(pin)) return fail(pinForm, { field: 'pin', message: 'Enter the staff PIN.' });
    busy(e.submitter || $('button[type="submit"]', pinForm), async () => {
      try {
        const done = await api('/api/staff/login', { pin });
        await openDesk(done.wrongSince);
      } catch (err) { $('#pin').value = ''; fail(pinForm, err.code === 'wrong-pin' || err.code === 'locked' ? { field: 'pin', message: err.message } : err); }
    });
  });

  $('#lock').addEventListener('click', async () => { try { await api('/api/staff/logout', {}); } catch (e) { /* locked here either way */ } lock('Locked.'); });

  /* ---------- the desk ---------- */
  function notices(wrongSince) {
    const st = state.status, list = [];
    const who = $('#who');
    who.hidden = !st.who;
    fill(who, st.who ? [h('span.chip.chip-on', icon('users'), st.who.role === 'owner' ? 'Owner' : st.who.name), st.who.role === 'owner' ? h('a.text-link', { href: '/admin/' }, 'Owner page: numbers, staff, stock, backup', icon('arrow-right')) : null] : []);
    if (st.who && st.who.role === 'owner' && st.lowStock) list.push(h('div.sign.sign-signal', h('p', h('strong', `${st.lowStock} ${st.lowStock === 1 ? 'size is' : 'sizes are'} at or below the minimum stock. `), h('a.text-link', { href: '/admin/#stock' }, 'See the stock list', icon('arrow-right')))));
    if (wrongSince) list.push(h('div.sign.sign-signal', h('p', h('strong', `${wrongSince} wrong PIN ${wrongSince === 1 ? 'try' : 'tries'} since the last sign-in. `), 'If that was not your staff, ask the owner to change the PIN.')));
    if (st.signIn === 'off') list.push(h('div.sign.sign-signal', h('p', h('strong', 'Customers cannot sign in yet. '), 'The SMS keys are not set on the server, so no sign-in codes can be sent.')));
    if (st.smsError) list.push(h('div.sign.sign-signal', h('p', h('strong', `Sign-in codes are failing since ${fmt.clock(st.smsError.at)}. `), `The SMS service answered: ${st.smsError.reason}. Customers cannot sign in until this is fixed.`)));
    fill($('#notices'), ...list);
    $('#desk-foot').textContent = st.mode === 'demo'
      ? 'Demo data: it resets every time the server restarts.'
      : `Records kept since ${fmt.stamp(st.database.since)}: ${fmt.n(st.database.customers)} customers. ${st.database.backupAt ? `Last backup ${fmt.clock(st.database.backupAt)}.` : 'No backup yet.'} The server sees this device as ${st.seenAs}.`;
  }

  async function openDesk(wrongSince) {
    state.status = await call('/api/staff/status');
    const st = state.status;
    $('#lock').hidden = false;
    fill($('#tyre-list'), ...st.tyres.map(t => h('option', { value: t })));
    // sizes the shop sells, written the way a sidewall shows them
    const sizes = ((window.HTA_DATA && window.HTA_DATA.sizes) || []).filter(x => /^\d{2,3}\/\d{2,3}[\/-]\d{2}$|^\d{1,2}\.\d{2}-\d{2}$/.test(x)).map(x => x.replace(/^(\d+\/\d+)\/(\d+)$/, '$1 R$2'));
    fill($('#size-list'), ...sizes.map(x => h('option', { value: x })));
    $('#sale-warranty').placeholder = String(st.warrantyMonths);
    $('#sale-date').max = st.today;
    $('#sale-ref').closest('.field').hidden = !st.referralOn;
    fill($('#qty-picks'), ...[1, 2, 4, 6].map(q => h('button.plate.plate-w.plate-mini', { type: 'button', tabindex: '-1', onclick: () => { $('#sale-qty').value = q; } }, h('span.plate-txt', String(q)))));
    notices(wrongSince);
    show('desk');
    selectTab('sale');
    counts();
    clearInterval(state.poll);
    // a quiet check every 45 seconds, so a new breakdown shows without anyone touching the screen
    state.poll = setInterval(async () => { try { state.status = await call('/api/staff/status', undefined, { passive: true }); counts(); } catch (e) { /* shown on the next action */ } }, 45000);
  }

  async function counts() {
    $('#count-help').textContent = state.status.breakdownsUnseen || '';
    try {
      const due = await call('/api/staff/due', undefined, { passive: true });
      const todo = due.items.filter(i => i.consent === 'yes' && (i.status === 'ready' || i.status === 'opened')).length;
      $('#count-due').textContent = todo || '';
    } catch (e) { /* the tab shows its own error when opened */ }
  }

  /* ---------- tabs ---------- */
  const tabs = $$('[role="tab"]');
  function selectTab(name) {
    for (const t of tabs) {
      const on = t.id === 'tab-' + name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    }
    if (name === 'due') loadDue();
    if (name === 'help') loadHelp();
  }
  for (const t of tabs) {
    t.addEventListener('click', () => selectTab(t.id.slice(4)));
    t.addEventListener('keydown', e => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = tabs[(tabs.indexOf(t) + step + tabs.length) % tabs.length];
      selectTab(next.id.slice(4));
      next.focus();
    });
  }

  /* ---------- new sale ---------- */
  const saleForm = $('#sale-form'), saleDone = $('#sale-done');

  // the number is read back in large digits, and a customer we already know offers their vehicles
  $('#sale-phone').addEventListener('input', e => {
    const d = e.target.value.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
    $('#sale-phone-back').textContent = d.length ? `${d.slice(0, 5)} ${d.slice(5, 10)}` : '';
    clearTimeout(state.lookupTimer);
    $('#sale-known').hidden = true;
    if (d.length !== 10) return;
    state.lookupTimer = setTimeout(async () => {
      try {
        const found = (await call('/api/staff/lookup', { q: d })).results.find(r => r.phone.endsWith(d));
        if (!found) return;
        $('#sale-known').hidden = false;
        fill($('#sale-known'), ...found.vehicles.map(v => vplate(v.regNo, { small: true, 'aria-label': `Known customer. Use vehicle ${fmt.plate(v.regNo)}`, onclick: () => { $('#sale-reg').value = fmt.plate(v.regNo); $('#sale-tyre').focus(); } })));
      } catch (err) { /* a lookup that fails only loses the shortcut */ }
    }, 350);
  });

  function readSale(confirm) {
    const f = saleForm, v = name => f.elements[name].value.trim();
    const body = {
      phone: v('phone'), regNo: v('regNo'), tyre: v('tyre'), size: v('size'), qty: whole(v('qty')), odometerKm: whole(v('odometerKm')),
      remindersOk: f.elements.remindersOk.checked, billNo: v('billNo') || null, amount: decimal(v('amount')), warrantyMonths: whole(v('warrantyMonths')),
      fittedOn: v('fittedOn') || null, newTreadMm: decimal(v('newTreadMm')), referralCode: v('referralCode') || null, idem: state.saleIdem,
    };
    if (confirm) body.confirm = true;
    // the first empty or unreadable box gets the message, in the order they appear on screen
    const needs = [['phone', 'Enter the mobile number.'], ['regNo', 'Enter the vehicle number.'], ['tyre', 'Enter the tyre brand and model.'], ['size', 'Enter the tyre size.']];
    for (const [name, message] of needs) if (!body[name]) return { error: { field: name, message } };
    for (const [name, message] of [['qty', 'Enter how many tyres, as a number.'], ['odometerKm', 'Enter the odometer reading, digits only.']]) if (body[name] == null || Number.isNaN(body[name])) return { error: { field: name, message } };
    for (const [name, message] of [['amount', 'Enter the amount in rupees, digits only.'], ['warrantyMonths', 'Enter the warranty in months.'], ['newTreadMm', 'Enter the tread depth in mm, for example 7.5.']]) if (Number.isNaN(body[name])) return { error: { field: name, message } };
    return { body };
  }

  function saveSale(button, confirm) {
    clearErrors(saleForm);
    $('#sale-anyway').hidden = true;
    const { body, error } = readSale(confirm);
    if (error) { if (['amount', 'warrantyMonths', 'newTreadMm'].includes(error.field)) $('.more', saleForm).open = true; return fail(saleForm, error); }
    busy(button, async () => {
      try {
        const done = await call('/api/staff/sales', body);
        state.saleIdem = idem();
        showSaleDone(done);
        counts();
      } catch (err) {
        if (['billNo', 'amount', 'warrantyMonths', 'fittedOn', 'newTreadMm', 'referralCode'].includes(err.field)) $('.more', saleForm).open = true;
        fail(saleForm, err);
        // an unusual value is refused once; staff can look again and save it on purpose
        $('#sale-anyway').hidden = !err.canConfirm;
      }
    });
  }
  saleForm.addEventListener('submit', e => { e.preventDefault(); saveSale(e.submitter || $('button[type="submit"]', saleForm), false); });
  $('#sale-anyway').addEventListener('click', e => saveSale(e.currentTarget, true));

  function showSaleDone(done) {
    const c = done.customer, v = c.vehicles.find(x => x.id === done.vehicleId);
    // the sale just saved is not always the newest fitting on the vehicle: an old record can be typed in later
    const isCurrent = v.current.id === done.saleId;
    const cur = isCurrent ? v.current : v.earlier.find(x => x.id === done.saleId) || v.current;
    const status = h('p.status', { role: 'status' });
    const consent = { yes: 'Reminders on', no: 'No reminders', stopped: 'Reminders stopped by customer' }[done.consent];
    const title = h('h2.sign-title', { tabindex: '-1' }, icon('check-circle'), done.duplicate ? 'Already saved' : 'Sale saved');
    fill(saleDone,
      title,
      done.duplicate ? h('p.note', 'This sale was saved a moment ago. Nothing was added twice.') : null,
      vplate(v.regNo),
      h('p.readback', fmt.phone(c.phone)),
      h('dl.facts',
        fact('Tyres', cur.tyre, `${cur.size} x ${cur.qty}`),
        fact('Visit card', `${c.card.place} of ${c.card.cardVisits}`),
        isCurrent ? fact('Estimate', fmt.day(cur.estimate.dueOn), basisLine(cur.estimate), true)
          : fact('Fitted on', fmt.day(cur.fittedOn), 'An earlier set. The newer tyres on this vehicle stay the current ones.', true)),
      h('p', h('span.chip' + (done.consent === 'yes' ? '.chip-on' : ''), consent)),
      done.consent === 'stopped' ? h('p.note', 'This customer stopped reminders earlier. Only they can turn them back on, from their own passport.') : null,
      done.earned.length ? h('p.note.note-warn', h('strong', 'Earned on this visit: '), `free ${fmt.list(done.earned.map(x => x.toLowerCase()))}.`) : null,
      done.referral ? h('p.note' + (done.referral.friendGot ? '.note-warn' : ''), done.referral.friendGot
        ? `Referred by a friend: this customer gets a free ${done.referral.service.toLowerCase()}${done.referral.referrerGot ? ', and so does the friend.' : done.referral.why === 'already-given' ? '. The friend already has theirs.' : '. The friend has reached this year\'s limit.'}`
        : 'A friend\'s invitation was on this number, but this vehicle is already on our records under another number, so no referral reward was given.') : null,
      done.stock ? h('p.note' + (done.stock.low ? '.note-alert' : ''), h('strong', 'Shelf count: '), `${done.stock.size} now ${done.stock.qty}` + (done.stock.low ? ` (minimum ${done.stock.minQty}). Tell the owner to reorder.` : '.')) : null,
      h('div.row',
        h('img', { src: `/api/staff/qr?sale=${cur.id}`, width: 150, height: 150, alt: 'QR code that opens this tyre passport' }),
        h('div.stack', h('p', 'Print the slip and staple it to the bill. The customer scans it and signs in with their own number. The job card goes to the fitter.'),
          plate('Print passport slip', { icon: 'printer', onclick: () => printSlip(v, cur) }),
          plate('Print job card', { kind: 'w', icon: 'wrench', href: `/staff/job/?sale=${cur.id}`, target: '_blank', rel: 'noopener' }))),
      status,
      h('div.row',
        plate('New sale', { icon: 'plus', onclick: resetSale }),
        plate('Open customer', { kind: 'w', onclick: () => { openCustomer(c, v.id); selectTab('visit'); } })),
      h('p', h('button.text-link', { type: 'button', onclick: e => busy(e.currentTarget, async () => {
        try { await call(`/api/staff/sales/${cur.id}/void`, {}); resetSale(true); $('.status', saleForm).textContent = 'That sale was removed. Enter it again.'; } catch (err) { status.textContent = err.message; status.classList.add('is-bad'); }
      }) }, 'Wrong details? Remove this sale')));
    saleForm.hidden = true;
    saleDone.hidden = false;
    title.focus();
    saleDone.scrollIntoView({ block: 'start' });
  }

  // keepValues: after removing a wrong sale the boxes stay filled, ready to correct and save again
  function resetSale(keepValues) {
    if (keepValues !== true) { saleForm.reset(); $('#sale-phone-back').textContent = ''; $('#sale-known').hidden = true; $('.more', saleForm).open = false; }
    clearErrors(saleForm);
    $('#sale-anyway').hidden = true;
    saleDone.hidden = true;
    saleForm.hidden = false;
    $('#sale-phone').focus();
  }

  function printSlip(v, cur) {
    const slip = $('#slip'), img = $('#slip-qr');
    $('#slip-plate').textContent = fmt.plate(v.regNo);
    $('#slip-tyre').textContent = `${cur.tyre}, ${cur.size} x ${cur.qty}. Fitted ${fmt.day(cur.fittedOn)}.`;
    const go = () => { slip.classList.add('is-printing'); print(); };
    addEventListener('afterprint', () => slip.classList.remove('is-printing'), { once: true });
    img.onload = go;
    img.onerror = go;
    img.src = `/api/staff/qr?sale=${cur.id}`;
  }

  /* ---------- find a customer ---------- */
  const findForm = $('#find-form');
  findForm.addEventListener('submit', e => {
    e.preventDefault();
    clearErrors(findForm);
    const q = $('#find-q').value.replace(/[\s+\-.]/g, '');
    if (q.length < 3) return fail(findForm, { field: 'q', message: 'Type at least 3 characters.' });
    busy(e.submitter || $('button[type="submit"]', findForm), async () => {
      try {
        const { results } = await call('/api/staff/lookup', { q });
        $('#customer').hidden = true;
        const box = $('#find-results');
        box.hidden = false;
        fill($('#find-list'), ...(results.length ? results.map(r => h('li',
          h('div.vplates', r.vehicles.map(v => vplate(v.regNo, { small: true, onclick: () => loadCustomer(r.customerId, v.id) }))),
          h('p.meta', `${fmt.phone(r.phone)}. Last visit ${fmt.day(r.lastVisitOn) || 'not recorded'}.`)))
          : [h('li', h('p.empty', 'Nobody matches. Check the number, or register the sale first.'))]));
        if (results.length === 1 && results[0].vehicles.length === 1) return loadCustomer(results[0].customerId, results[0].vehicles[0].id);
        $('.sign-title', box).focus();
      } catch (err) { fail(findForm, err); }
    });
  });

  async function loadCustomer(id, vehicleId) {
    try { openCustomer((await call(`/api/staff/customers/${id}`)).customer, vehicleId); } catch (err) { fail(findForm, err); }
  }

  /* ---------- one customer: log a visit, free services, reminders, corrections ---------- */
  // keep: the same customer redrawn after an action, so the screen stays where the worker was looking
  function openCustomer(c, vehicleId, keep) {
    const y = scrollY;
    state.customer = c;
    const v = c.vehicles.find(x => x.id === (vehicleId || state.vehicleId)) || c.vehicles[0];
    state.vehicleId = v ? v.id : null;
    $('#find-results').hidden = true;
    const box = $('#customer');
    box.hidden = false;
    if (!v) return fill(box, sign('No vehicle left', null, h('p', 'This customer has no sale on record any more.')), manageSign(c, null));
    const cur = v.current, e = cur.estimate;
    const title = h('h2.kicker', { tabindex: '-1' }, `Customer ${fmt.phone(c.phone)}`);
    fill(box,
      title,
      c.vehicles.length > 1 ? h('div.vplates', c.vehicles.map(x => vplate(x.regNo, { small: true, 'aria-pressed': String(x.id === v.id), onclick: () => openCustomer(c, x.id) }))) : null,
      vplate(v.regNo),
      sign('On this vehicle', 'tire',
        e.atLimit ? h('p.note.note-alert', icon('warning'), ` Last reading is at or below the legal limit of ${fmt.mm(e.legalMinMm)}. These tyres need replacing now.`) : null,
        h('p.big', cur.tyre),
        h('dl.facts',
          fact('Size and number', `${cur.size} x ${cur.qty}`),
          fact('Fitted on', fmt.day(cur.fittedOn), `at ${fmt.km(cur.odometerKm)}`),
          fact('Bill', cur.billNo || 'Not entered', cur.amountPaise != null ? fmt.rupees(cur.amountPaise) : null),
          fact('Warranty', cur.warranty ? (cur.warranty.active ? `Until ${fmt.day(cur.warranty.until)}` : `Ended ${fmt.day(cur.warranty.until)}`) : 'None'),
          fact('Estimate', dueLine(e), `${basisLine(e)} About ${fmt.n(e.kmPerMonth)} km a month${e.kmPerMonthMeasured ? ' (from the odometer)' : ' (typical)'}.`, true),
          cur.services.map(sv => fact(sv.name, sv.daysLeft <= 0 ? 'Due now' : fmt.day(sv.dueOn), sv.lastDoneOn ? `Last done ${fmt.day(sv.lastDoneOn)}` : 'Not done since fitting')))),
      visitForm(v),
      freeSign(c),
      remindersSign(c),
      sign('History', 'clock', h('ul.rows', v.history.map(x => h('li',
        h('p.rows-title', fmt.day(x.on)),
        h('p', x.kind === 'purchase' ? 'Tyres fitted.' : x.services.length ? `${fmt.list(x.services)}.` : 'Reading only.'),
        h('p.meta', [x.odometerKm != null ? `Odometer ${fmt.km(x.odometerKm)}` : null, x.treadMm != null ? `Lowest tread ${fmt.mm(x.treadMm)}` : null].filter(Boolean).join('. ')))))),
      manageSign(c, v));
    if (keep) return scrollTo({ top: y, behavior: 'instant' });
    title.focus();
    box.scrollIntoView({ block: 'start' });
  }

  function visitForm(v) {
    const id = n => `visit-${n}`;
    const status = h('p.status', { role: 'status' });
    const anyway = plate('Save anyway', { kind: 'w', hidden: true });
    const form = h('form.sign.form', { novalidate: true },
      h('h2.sign-title', icon('wrench'), 'Log this visit'),
      h('div.form-2',
        h('div.field', h('label', { for: id('odo') }, 'Odometer now (km)'), h('div.fplate', h('input', { id: id('odo'), name: 'odometerKm', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '9' }))),
        h('div.field', h('label', { for: id('tread') }, 'Lowest tread depth (mm)'), h('div.fplate', h('input', { id: id('tread'), name: 'treadMm', type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '4', 'aria-describedby': id('tread-hint') })),
          h('p.hint', { id: id('tread-hint') }, 'The most worn tyre, at its shallowest groove.'))),
      h('fieldset.field', h('legend', 'Done today'), h('div.checks', state.status.services.map(sv =>
        h('label.check', h('input', { type: 'checkbox', name: 'services', value: sv.key }), h('span', sv.name))))),
      status,
      h('div.row', plate('Save visit', { icon: 'check', type: 'submit' }), anyway));

    const save = (button, confirm) => {
      clearErrors(form);
      anyway.hidden = true;
      const body = { vehicleId: v.id, odometerKm: whole(form.elements.odometerKm.value.trim()), treadMm: decimal(form.elements.treadMm.value.trim()), services: $$('input[name="services"]:checked', form).map(x => x.value), idem: state.visitIdem };
      if (confirm) body.confirm = true;
      if (Number.isNaN(body.odometerKm)) return fail(form, { field: 'odometerKm', message: 'Enter the odometer reading, digits only.' });
      if (Number.isNaN(body.treadMm)) return fail(form, { field: 'treadMm', message: 'Enter the tread depth in mm, for example 4.5.' });
      if (body.odometerKm == null && body.treadMm == null && !body.services.length) return fail(form, { message: 'Enter a reading, or tick what was done.' });
      busy(button, async () => {
        try {
          const done = await call('/api/staff/visits', body);
          state.visitIdem = idem();
          openCustomer(done.customer, v.id, true);
          say(done.earned.length ? `Visit saved. Earned: free ${fmt.list(done.earned.map(x => x.toLowerCase()))}.` : 'Visit saved.');
          counts();
        } catch (err) { fail(form, err); anyway.hidden = !err.canConfirm; }
      });
    };
    form.addEventListener('submit', e => { e.preventDefault(); save(e.submitter || $('button[type="submit"]', form), false); });
    anyway.addEventListener('click', e => save(e.currentTarget, true));
    return form;
  }

  // free services are marked used here, by staff, and nowhere else
  function freeSign(c) {
    const card = c.card, status = h('p.status', { role: 'status' });
    const act = (path, button, done) => busy(button, async () => {
      try { openCustomer((await call(path, {})).customer, state.vehicleId, true); say(done); } catch (err) { say(err.message, true); }
    });
    const fresh = card.used.filter(g => Date.now() - g.usedAt < 10 * 60000);
    return sign('Visit card and free services', 'gift',
      h('p', `Visit ${card.place} of ${card.cardVisits}. Free on the card: ${fmt.list(card.steps.map(st => `${st.name.toLowerCase()} at visit ${st.atVisit}`))}.`),
      card.available.length
        ? h('ul.rows', card.available.map(g => h('li', h('div.row.spread',
          h('p.rows-title', `Free ${g.name.toLowerCase()}`),
          plate('Mark used', { mini: true, kind: 'k', icon: 'check', onclick: e => act(`/api/staff/grants/${g.id}/use`, e.currentTarget, `Free ${g.name.toLowerCase()} marked used.`) })),
        h('p.meta', g.source === 'referral' ? 'For a referral.' : 'From the visit card.'))))
        : h('p.empty', 'No free service waiting.'),
      fresh.length ? h('ul.rows', fresh.map(g => h('li', h('div.row.spread',
        h('p', `Free ${g.name.toLowerCase()} marked used at ${fmt.clock(g.usedAt)}.`),
        plate('Undo', { mini: true, kind: 'w', icon: 'arrow-counter-clockwise', onclick: e => act(`/api/staff/grants/${g.id}/unuse`, e.currentTarget, `Free ${g.name.toLowerCase()} is available again.`) }))))) : null,
      status);
  }

  function remindersSign(c) {
    const r = c.reminders, status = h('p.status', { role: 'status' });
    const set = (on, button) => busy(button, async () => {
      try { openCustomer((await call(`/api/staff/customers/${c.customerId}/reminders`, { on })).customer, state.vehicleId, true); say(on ? 'Reminders are on for this customer.' : 'Reminders stopped for this customer.'); counts(); } catch (err) { say(err.message, true); }
    });
    return sign('Reminders', 'bell',
      h('p', h('span.chip' + (r.state === 'yes' ? '.chip-on' : ''), { yes: 'On', no: 'Off', stopped: 'Stopped' }[r.state]), ' ',
        r.state === 'yes' ? `Agreed ${r.by === 'staff' ? 'at the counter' : 'in their passport'} on ${fmt.stamp(r.at)}.`
          : r.state === 'stopped' ? `Stopped on ${fmt.stamp(r.at)}. Only the customer can turn them back on, from their own passport.`
            : 'The customer has not been asked, or said no.'),
      status,
      h('div.row',
        r.state === 'no' ? plate('Customer said yes', { mini: true, icon: 'bell', onclick: e => set(true, e.currentTarget) }) : null,
        r.state === 'yes' ? plate('Customer asked to stop', { mini: true, kind: 'w', icon: 'bell-slash', onclick: e => set(false, e.currentTarget) }) : null));
  }

  function manageSign(c, v) {
    const cur = v && v.current;
    const status = h('p.status', { role: 'status' });
    const fresh = cur && Date.now() - cur.enteredAt < 24 * 3600000;
    return h('details.sign.more', h('summary', 'Slip, corrections and deleting', icon('caret-down')),
      h('div.stack',
        cur ? h('div.row',
          h('img', { src: `/api/staff/qr?sale=${cur.id}`, width: 130, height: 130, alt: 'QR code that opens this tyre passport' }),
          h('div.stack', plate('Print passport slip', { mini: true, icon: 'printer', onclick: () => printSlip(v, cur) }),
            plate('Job card', { mini: true, kind: 'w', icon: 'wrench', href: `/staff/job/?sale=${cur.id}`, target: '_blank', rel: 'noopener' }))) : null,
        v ? h('p', h('button.text-link', { type: 'button', onclick: () => { clearErrors(renameForm); $('#rename-reg').value = fmt.plate(v.regNo); renameForm.dataset.vehicle = v.id; $('#rename-dialog').showModal(); } }, 'Correct the vehicle number')) : null,
        fresh ? h('p', h('button.text-link', { type: 'button', onclick: e => busy(e.currentTarget, async () => {
          try { const done = await call(`/api/staff/sales/${cur.id}/void`, {}); if (done.customer) openCustomer(done.customer); else { $('#customer').hidden = true; $('.status', findForm).textContent = 'Sale removed. Nothing is left on that number.'; } counts(); } catch (err) { status.textContent = err.message; status.classList.add('is-bad'); }
        }) }, 'Remove the latest sale (entered by mistake)')) : null,
        h('p', h('button.text-link', { type: 'button', onclick: () => { clearErrors(forgetForm); $('#forget-last4').value = ''; forgetForm.dataset.customer = c.customerId; $('#forget-dialog').showModal(); } }, 'Customer asked to delete their data')),
        status));
  }

  const renameForm = $('#rename-form'), forgetForm = $('#forget-form');
  for (const b of $$('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
  renameForm.addEventListener('submit', e => {
    e.preventDefault();
    clearErrors(renameForm);
    busy(e.submitter || $('button[type="submit"]', renameForm), async () => {
      try {
        const done = await call(`/api/staff/vehicles/${renameForm.dataset.vehicle}`, { regNo: $('#rename-reg').value.trim() });
        $('#rename-dialog').close();
        openCustomer(done.customer, Number(renameForm.dataset.vehicle), true);
        say('Vehicle number corrected.');
      } catch (err) { fail(renameForm, err); }
    });
  });
  forgetForm.addEventListener('submit', e => {
    e.preventDefault();
    clearErrors(forgetForm);
    busy(e.submitter || $('button[type="submit"]', forgetForm), async () => {
      try {
        await call(`/api/staff/customers/${forgetForm.dataset.customer}/delete`, { last4: $('#forget-last4').value.trim() });
        $('#forget-dialog').close();
        state.customer = null;
        $('#customer').hidden = true;
        $('.status', findForm).textContent = 'That customer\'s data has been deleted.';
        counts();
      } catch (err) { fail(forgetForm, err); }
    });
  });

  /* ---------- due soon ---------- */
  // Nothing here sends anything. "Open in WhatsApp" opens the chat with the message written; a person presses
  // send, and then says here whether they did. The words on screen are "opened" and "marked as sent by staff".
  function dueItem(item, reload) {
    const what = item.type === 'replacement'
      ? `Replacement ${item.daysLeft <= 0 ? `was due ${fmt.day(item.dueOn)}` : `due ${fmt.day(item.dueOn)}`}`
      : `${fmt.list(item.services)} due ${fmt.day(item.dueOn)}`;
    const mark = (status, button) => busy(button, async () => {
      try { await call('/api/staff/reminders', { key: item.key, status }); } catch (err) { say(err.message, true); }
      reload();
    });
    // The chat opens with what the server says at this moment, not with what was drawn on screen earlier: if the
    // customer stopped reminders a minute ago, nothing opens. The blank tab comes first so the browser allows it.
    const open = label => plate(label, { mini: true, kind: 'k', icon: 'whatsapp-logo', onclick: async () => {
      const tab = window.open('', '_blank');
      try {
        const done = await call('/api/staff/reminders', { key: item.key, status: 'opened' });
        if (tab) { tab.opener = null; tab.location.replace(done.item.waUrl); } else location.href = done.item.waUrl;
      } catch (err) {
        if (tab) tab.close();
        say(err.message, true);
      }
      reload();
    } });
    let actions;
    if (item.consent === 'no') actions = h('p.note', 'No yes to reminders on record, so nothing can be sent. Ask at the next visit.');
    else if (item.consent === 'stopped') actions = h('p.note', 'This customer stopped reminders. Nothing can be sent.');
    else if (item.status === 'opened') actions = h('div.stack', h('p', h('strong', `Opened in WhatsApp at ${fmt.clock(item.statusAt)}. `), 'Did you press send?'),
      h('div.row', plate('Yes, mark as sent', { mini: true, icon: 'check', onclick: e => mark('marked_sent', e.currentTarget) }), plate('Not sent', { mini: true, kind: 'w', onclick: e => mark('skipped', e.currentTarget) }), open('Open again')));
    else if (item.status === 'marked_sent') actions = h('p', h('span.chip.chip-on', 'Marked as sent by staff'), ` ${fmt.clock(item.statusAt)}`);
    else if (item.status === 'skipped') actions = h('div.row', h('span.chip', 'Not sent'), open('Open in WhatsApp'));
    else actions = h('div.row', open('Open in WhatsApp'), plate('Skip', { mini: true, kind: 'w', onclick: e => mark('skipped', e.currentTarget) }));

    return h('li',
      h('div.row.spread', vplate(item.regNo, { small: true, 'aria-label': `Open customer ${fmt.plate(item.regNo)}`, onclick: () => { loadCustomer(item.customerId, item.vehicleId); selectTab('visit'); } }),
        h('span.chip' + (item.daysLeft <= 0 ? '.chip-warn' : ''), item.daysLeft <= 0 ? 'Due now' : fmt.days(item.daysLeft))),
      h('p.rows-title', what),
      h('p.meta', `${item.tyre}, ${item.size}. Fitted ${fmt.day(item.fittedOn)}. ${item.type === 'replacement' ? (item.reason === 'age' ? 'Due by age.' : item.basis === 'readings' ? `From ${item.readings} readings.` : 'From typical tyre life.') : item.free.length ? `Free ${fmt.list(item.free.map(x => x.toLowerCase()))} waiting on the card.` : ''}`),
      item.atLimit ? h('p.note.note-alert', 'Last reading was at or below the legal limit.') : null,
      item.message ? h('details.more', h('summary', 'Read the message', icon('caret-down')), h('p', item.message)) : null,
      actions);
  }

  async function loadDue() {
    const list = $('#due-list');
    $('#due-status').textContent = '';
    try {
      const due = await call('/api/staff/due');
      $('#due-intro').textContent = `Tyres estimated to need replacing within ${due.leadDays} days, and services that are due. Messages are prepared only for customers who said yes.${state.status.mode === 'demo' ? ' Demo: these are sample numbers, so WhatsApp will open but nobody receives anything.' : ''}`;
      fill(list, ...(due.items.length ? due.items.map(i => dueItem(i, loadDue)) : [h('li', h('p.empty', 'Nobody is due right now.'))]));
      const todo = due.items.filter(i => i.consent === 'yes' && (i.status === 'ready' || i.status === 'opened')).length;
      $('#count-due').textContent = todo || '';
    } catch (err) { $('#due-status').textContent = err.message; $('#due-status').classList.add('is-bad'); }
  }

  /* ---------- breakdowns ---------- */
  async function loadHelp() {
    const list = $('#help-list');
    try {
      const { items } = await call('/api/staff/breakdowns');
      fill(list, ...(items.length ? items.map(b => h('li',
        h('div.row.spread', h('p.rows-title', fmt.clock(b.at)), b.seenAt ? h('span.chip', 'Seen') : h('span.chip.chip-warn', 'New')),
        h('div.row', b.regNo ? vplate(b.regNo, { small: true, onclick: () => { loadCustomer(b.customerId, b.vehicleId); selectTab('visit'); } }) : null,
          plate(`Call ${fmt.phone(b.phone)}`, { mini: true, icon: 'phone', href: `tel:${b.phone}` })),
        b.lat != null
          ? h('p', h('a.text-link', { href: `https://www.google.com/maps?q=${b.lat},${b.lng}`, target: '_blank', rel: 'noopener' }, icon('map-pin'), 'Open the location in Maps'), b.accuracyM != null ? h('span.meta', ` Accurate to about ${fmt.n(b.accuracyM)} m.`) : null)
          : h('p.note', 'No location was shared. Ask on the call.'),
        b.seenAt ? null : h('div.row', plate('Mark as seen', { mini: true, kind: 'w', icon: 'check', onclick: e => busy(e.currentTarget, async () => { try { await call(`/api/staff/breakdowns/${b.id}/seen`, {}); state.status = await call('/api/staff/status'); counts(); } catch (err) { /* stays listed as new */ } loadHelp(); }) }))))
        : [h('li', h('p.empty', 'No breakdowns in the last 7 days.'))]));
    } catch (err) { fill(list, h('li', h('p.status.is-bad', err.message))); }
  }

  /* ---------- start ---------- */
  (async () => {
    try {
      state.cfg = await config();
      await openDesk(0);
    } catch (err) {
      if (err.code !== 'staff-signed-out') return lock(err.message);
      lock('');
    }
  })();
  addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
})();
