/* Tyre passport, customer side: sign in by phone and one-time code, then the vehicle, tyres, warranty, estimate,
   visit card, referral link, service history and the breakdown button. */
(function () {
  'use strict';
  const { $, $$, h, icon, fill, plate, vplate, fmt, api, show, fail, clearErrors, busy, say, inPlace, config } = window.HTA;

  const state = { cfg: null, me: null, phone: '', vehicleId: null, resendAt: 0, ticker: 0, ref: null, sale: null };

  /* The QR code on a bill carries its token after the #, which browsers never send to a server, and an
     invitation carries ?ref=. Both are lifted out of the address bar at once and kept for this tab only. */
  const stash = {
    get(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch (e) { /* private mode: this tab only */ } },
    del(key) { try { sessionStorage.removeItem(key); } catch (e) { /* nothing was kept */ } },
  };
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('s');
  const fromQuery = new URLSearchParams(location.search).get('ref');
  if (/^[A-Za-z0-9_-]{16,64}$/.test(fromHash || '')) stash.set('hta_sale', fromHash);
  if (/^[A-Za-z0-9]{8}$/.test(fromQuery || '')) stash.set('hta_ref', fromQuery.toUpperCase());
  state.sale = stash.get('hta_sale');
  state.ref = stash.get('hta_ref');
  if (fromHash || fromQuery) history.replaceState(null, '', location.pathname);

  const digits = v => v.replace(/\D/g, '');
  const shopTel = shop => 'tel:' + shop.phone;

  /* ---------- sign in ---------- */
  const phoneForm = $('#phone-form'), codeForm = $('#code-form');

  function showSignIn() {
    const { cfg } = state;
    show('signin');
    phoneForm.hidden = false;
    codeForm.hidden = true;
    $('#signin-off').hidden = cfg.signIn !== 'off';
    phoneForm.hidden = cfg.signIn === 'off';
    if (state.ref && cfg.referral) { $('#invite').hidden = false; $('#invite-service').textContent = cfg.referral.service.toLowerCase(); }
    // said once, after signing out or deleting on this device
    const note = stash.get('hta_note');
    if (note) { stash.del('hta_note'); $('.status', phoneForm).textContent = note; }
    if (cfg.demo) {
      $('#demo-samples').hidden = false;
      fill($('#demo-picks'), ...cfg.demo.samples.map(sample =>
        h('button.plate.plate-w.plate-mini', { type: 'button', title: sample.note, onclick: () => { $('#si-phone').value = sample.phone; phoneForm.requestSubmit(); } },
          h('span.plate-txt', `${sample.phone.slice(0, 5)} ${sample.phone.slice(5)}`))));
    }
  }

  async function requestCode() {
    const data = await api('/api/auth/request', { phone: state.phone, ref: state.ref || undefined });
    const pending = { phone: state.phone, at: Date.now(), resendAt: Date.now() + data.wait * 1000, demo: data.demo || null };
    // kept for this tab, so a phone that reloads the page while the customer reads the SMS comes back to this step
    stash.set('hta_pending', JSON.stringify(pending));
    showCodeStep(pending);
  }

  function showCodeStep(pending) {
    phoneForm.hidden = true;
    codeForm.hidden = false;
    clearErrors(codeForm);
    $('#si-code').value = '';
    // the same words for every number: the page never says whether a number is a customer
    $('#code-sent').textContent = `If the number ending ${state.phone.slice(-4)} has a tyre passport, we have asked for a 6 digit code to be sent to it. It can take a minute to arrive.`;
    // the bill's QR code or an invitation stands in for the vehicle number; the server asks for it if it is still needed
    $('#plate-field').hidden = !!(state.sale || state.ref);
    const demo = $('#demo-code');
    demo.hidden = !pending.demo;
    if (pending.demo) {
      const sample = state.cfg.demo && state.cfg.demo.samples.find(x => x.phone === state.phone);
      fill(demo, h('p', h('strong', 'Demo. '), pending.demo.code ? `No SMS was sent. Your code is ${pending.demo.code}.` : 'No sample customer has this number, so no code was made.'),
        sample ? h('p', `The vehicle is ${fmt.plate(sample.plate)}, so the last 4 characters are ${sample.plate.slice(-4)}.`) : null);
    }
    state.resendAt = pending.resendAt;
    clearInterval(state.ticker);
    const tick = () => {
      const left = Math.ceil((state.resendAt - Date.now()) / 1000), again = $('#resend');
      again.disabled = left > 0;
      again.textContent = left > 0 ? `Send a new code in ${left}s` : 'Send a new code';
      if (left <= 0) clearInterval(state.ticker);
    };
    tick();
    state.ticker = setInterval(tick, 1000);
    $('#code-title').focus();
  }

  phoneForm.addEventListener('submit', e => {
    e.preventDefault();
    clearErrors(phoneForm);
    state.phone = digits($('#si-phone').value).replace(/^(91|0)(?=\d{10}$)/, '');
    if (state.phone.length !== 10) return fail(phoneForm, { field: 'phone', message: 'Enter your 10 digit mobile number.' });
    busy(e.submitter || $('button[type="submit"]', phoneForm), () => requestCode().catch(err => fail(phoneForm, err)));
  });

  $('#resend').addEventListener('click', e => busy(e.currentTarget, () => requestCode().catch(err => fail(codeForm, err))));
  $('#change-number').addEventListener('click', () => { clearInterval(state.ticker); stash.del('hta_pending'); showSignIn(); $('#si-phone').focus(); });

  codeForm.addEventListener('submit', e => {
    e.preventDefault();
    clearErrors(codeForm);
    const code = digits($('#si-code').value), tail = $('#si-plate').value.replace(/[\s-]/g, '').toUpperCase();
    if (code.length !== 6) return fail(codeForm, { field: 'code', message: 'Enter the 6 digit code.' });
    const asksPlate = !$('#plate-field').hidden;
    if (asksPlate && tail.length !== 4) return fail(codeForm, { field: 'plate', message: 'Enter the last 4 characters of your vehicle number.' });
    busy(e.submitter || $('button[type="submit"]', codeForm), async () => {
      try {
        const done = await api('/api/auth/verify', { phone: state.phone, code, plate: asksPlate ? tail : undefined, sale: state.sale || undefined, ref: state.ref || undefined });
        clearInterval(state.ticker);
        for (const key of ['hta_pending', 'hta_sale', 'hta_ref']) stash.del(key);
        state.vehicleId = done.focusVehicleId;
        await load();
      } catch (err) {
        // the code was right but this passport also needs the vehicle number: show the box and keep the code
        if (err.code === 'need-plate' || err.code === 'bad-plate') { $('#plate-field').hidden = false; return fail(codeForm, { field: 'plate', message: err.message }); }
        if (err.code === 'bad-code') return fail(codeForm, { field: 'code', message: err.message });
        fail(codeForm, err);
      }
    });
  });

  /* ---------- the passport ---------- */
  const sign = (title, iconName, ...kids) => h('section.sign', h('h2.sign-title', iconName ? icon(iconName) : null, title), kids);
  const fact = (label, value, small, wide) => [h('dt' + (wide ? '.wide' : ''), label), h('dd' + (wide ? '.wide' : ''), value, small ? h('small', small) : null)];

  function tyresSign(cur) {
    const w = cur.warranty;
    return sign('Tyres fitted', 'tire',
      h('p.big', cur.tyre),
      h('dl.facts',
        fact('Size and number', `${cur.size} x ${cur.qty}`),
        fact('Fitted on', fmt.day(cur.fittedOn)),
        fact('Odometer at fitting', fmt.km(cur.odometerKm)),
        fact('Bill', cur.billNo || 'Ask at the shop', cur.amountPaise != null ? fmt.rupees(cur.amountPaise) : null),
        w ? fact('Warranty', w.active ? `Until ${fmt.day(w.until)}` : `Ended ${fmt.day(w.until)}`, `${w.months} months from fitting, against manufacturing defects, on the tyre maker's terms.`, true) : null),
      w ? h('p', h('a.text-link', { href: w.policyUrl }, 'Read the warranty policy', icon('arrow-right'))) : null);
  }

  function estimateSign(cur) {
    const e = cur.estimate;
    const overdue = e.daysLeft <= 0;
    const basis = e.basis === 'readings'
      ? `Worked out from ${e.readings} readings: the day of fitting, and the tread depth we measured since, most recently ${fmt.mm(e.lastReadingMm)} on ${fmt.day(e.lastReadingOn)}.`
      : `An estimate from typical tyre life (${fmt.km(e.typicalLifeKm)}) ${e.kmPerMonthMeasured ? 'and the distance your odometer shows you drive' : 'and typical monthly distance'}. ${e.lastReadingOn ? `It is held to the ${fmt.mm(e.lastReadingMm)} we measured on ${fmt.day(e.lastReadingOn)}, and gets sharper with the next reading.` : 'It gets sharper once we measure your tread on a visit.'}`;
    const span = e.newTreadMm, pct = v => `${Math.max(0, Math.min(100, (v / span) * 100)).toFixed(1)}%`;
    const fill = h('span.gauge-fill'), stop = h('span.gauge-stop');
    fill.style.width = pct(e.treadNowMm);
    stop.style.width = pct(e.replaceAtMm);
    return sign('Replacement estimate', 'gauge',
      e.atLimit ? h('p.note.note-alert', icon('warning'), ` At or below the legal limit of ${fmt.mm(e.legalMinMm)}. Replace these tyres now.`) : null,
      h('p.big', overdue ? 'Due now' : `Around ${fmt.day(e.dueOn)}`),
      h('p', overdue
        ? `By our estimate these tyres reached replacement ${fmt.days(e.daysLeft)}. Come in for a free tread check.`
        : e.reason === 'age'
          ? `That is when these tyres turn ${Math.round((new Date(e.dueOn) - new Date(cur.fittedOn)) / 31557600000)} years old, the age at which tyres should be changed whatever the tread.`
          : `About ${fmt.span(e.daysLeft)} from now, or roughly ${fmt.km(e.kmLeft)} at ${fmt.n(e.kmPerMonth)} km a month.`),
      h('div.stack', { role: 'img', 'aria-label': `Tread about ${fmt.mm(e.treadNowMm)} now. New was ${fmt.mm(e.newTreadMm)}. Replace at ${fmt.mm(e.replaceAtMm)}.` },
        h('div.gauge', fill, stop),
        h('p.gauge-key', h('span', `Replace at ${fmt.mm(e.replaceAtMm)}`), h('span', `About ${fmt.mm(e.treadNowMm)} now`), h('span', `New ${fmt.mm(e.newTreadMm)}`))),
      h('p.muted', basis));
  }

  function servicesSign(cur) {
    if (!cur.services.length) return null;
    return sign('Next services', 'wrench', h('ul.rows', cur.services.map(sv =>
      h('li', h('p.rows-title', sv.name),
        h('p', sv.daysLeft <= 0 ? `Due now (since ${fmt.day(sv.dueOn)}).` : `Due around ${fmt.day(sv.dueOn)}, ${fmt.days(sv.daysLeft)}.`),
        h('p.meta', `Every ${fmt.km(sv.everyKm)} or ${sv.everyMonths} months, whichever comes first. ${sv.lastDoneOn ? `Last done ${fmt.day(sv.lastDoneOn)}.` : 'Not done since fitting.'}`)))));
  }

  function remindersSign(me) {
    const r = me.reminders, on = r.state === 'yes';
    const status = h('p.status', { role: 'status' });
    const button = plate(on ? 'Stop reminders' : 'Send me reminders', {
      kind: on ? 'w' : null, icon: on ? 'bell-slash' : 'bell',
      onclick: e => busy(e.currentTarget, async () => {
        try { await api('/api/me/reminders', { on: !on }); await load(); say(on ? 'Reminders stopped.' : 'Reminders are on.'); } catch (err) { say(err.message, true); }
      }),
    });
    return sign('Reminders', 'bell',
      h('p', h('span.chip' + (on ? '.chip-on' : ''), on ? 'On' : 'Off'), ' ',
        on ? (r.by === 'staff' ? `You said yes at the shop on ${fmt.stamp(r.at)}.` : `You turned them on on ${fmt.stamp(r.at)}.`) : r.state === 'stopped' ? `Stopped on ${fmt.stamp(r.at)}.` : 'You have not asked for reminders.'),
      h('p', 'One WhatsApp message about a month before your tyres are due for replacement, and one when a rotation or alignment check is due. Nothing else, and you can stop them here at any time.'),
      status, h('div.row', button));
  }

  function cardSign(card) {
    const places = Array.from({ length: card.cardVisits }, (x, i) => i + 1);
    return sign('Visit card', 'stamp',
      h('p', `Every visit earns a stamp. ${card.place} of ${card.cardVisits} so far${card.stamps > card.cardVisits ? `, ${card.stamps} visits in all` : ''}.`),
      h('ol.stamps', { 'aria-label': 'Visit card' }, places.map(pl => {
        const step = card.steps.find(st => st.atVisit === pl), got = pl <= card.place;
        return h('li' + (got ? '.is-stamped' : '') + (step ? '.is-gift' : ''),
          h('span.stamp', step ? icon('gift') : String(pl)),
          h('span', step ? `Free ${step.name.toLowerCase()}` : got ? 'Visited' : `Visit ${pl}`));
      })),
      card.available.length
        ? h('div.note.note-warn', h('p', h('strong', 'Ready to use. '), 'Show this screen at the counter.'),
          h('ul', card.available.map(g => h('li', `Free ${g.name.toLowerCase()}`, g.source === 'referral' ? ' (for a friend you invited)' : ''))))
        : h('p.muted', 'No free service waiting yet.'),
      card.used.length ? h('p.muted', `Used: ${fmt.list(card.used.map(g => `${g.name.toLowerCase()} (${fmt.stamp(g.usedAt)})`))}.`) : null);
  }

  function referralSign(ref) {
    if (!ref) return null;
    const status = h('p.status', { role: 'status' });
    const text = `I get my tyres from Hindustan Tyre Agencies, Ludhiana. Sign in with this link before you buy and we each get a free ${ref.service.toLowerCase()}: ${ref.link}`;
    const share = async () => {
      try {
        if (navigator.share) await navigator.share({ title: 'Hindustan Tyre Agencies', text });
        else { await navigator.clipboard.writeText(text); status.textContent = 'Copied. Paste it into a message to your friend.'; }
      } catch (e) { if (e && e.name !== 'AbortError') status.textContent = 'Could not share from this browser. Use the WhatsApp button.'; }
    };
    return sign('Refer a friend', 'users',
      h('p', `Share your link. When a friend signs in with it and then buys tyres from us for the first time, you each get a free ${ref.service.toLowerCase()}.`),
      ref.joined ? h('p', h('span.chip.chip-on', `${ref.joined} joined`), ' Thank you.') : null,
      status,
      h('div.row',
        plate('Share my link', { icon: 'share-network', onclick: share }),
        plate('WhatsApp', { kind: 'k', icon: 'whatsapp-logo', href: `https://wa.me/?text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener' })));
  }

  function historySign(v) {
    return sign('Service history', 'clock', v.history.length
      ? h('ul.rows', v.history.map(x => h('li',
        h('p.rows-title', fmt.day(x.on)),
        h('p', x.kind === 'purchase' ? 'Tyres fitted.' : x.services.length ? `${fmt.list(x.services)}.` : 'Check.'),
        h('p.meta', [x.odometerKm != null ? `Odometer ${fmt.km(x.odometerKm)}` : null, x.treadMm != null ? `Lowest tread ${fmt.mm(x.treadMm)}` : null].filter(Boolean).join('. ')))))
      : h('p.empty', 'No visits yet.'),
    v.earlier.length ? h('p.muted', `Earlier tyres on this vehicle: ${fmt.list(v.earlier.map(s => `${s.tyre} ${s.size} (${fmt.day(s.fittedOn)})`))}.`) : null);
  }

  function renderPassport() {
    const me = state.me;
    const v = me.vehicles.find(x => x.id === state.vehicleId) || me.vehicles[0];
    state.vehicleId = v.id;
    const picker = $('#p-vehicles');
    picker.hidden = me.vehicles.length < 2;
    fill(picker, ...me.vehicles.map(x => vplate(x.regNo, { small: true, 'aria-pressed': String(x.id === v.id), onclick: () => { state.vehicleId = x.id; renderPassport(); } })));
    fill($('#p-plate'), vplate(v.regNo));
    $('#p-last4').textContent = me.phoneLast4;
    const cur = v.current;
    fill($('#p-body'), ...[
      cur ? tyresSign(cur) : null,
      cur ? estimateSign(cur) : null,
      cur ? servicesSign(cur) : null,
      remindersSign(me),
      cardSign(me.card),
      referralSign(me.referral),
      historySign(v),
    ].filter(Boolean));
  }

  /* ---------- breakdown: one tap calls the shop and shares the location ---------- */
  // The button is a real phone link, so it still calls with scripts off or a dead connection. With scripts on,
  // the tap first asks for the location for a few seconds, posts it, and then opens the dialler whatever happened.
  function setupBreakdown() {
    const call = $('#bd-call'), status = $('#bd-status'), wa = $('#bd-wa');
    let running = false;
    let shop = state.cfg.shops[0];
    const tell = (text, bad) => { $('#bd-after').hidden = false; status.textContent = text; status.classList.toggle('is-bad', !!bad); };
    const setShop = next => { shop = next; call.href = shopTel(shop); };
    setShop(shop);

    // the phone gets half a minute to find itself (the first time it also has to ask permission); the call never waits that long
    const locate = () => new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(pos => resolve(pos.coords), () => resolve(null), { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 });
    });
    const send = at => api('/api/me/breakdown', at ? { lat: at.latitude, lng: at.longitude, accuracyM: at.accuracy, vehicleId: state.vehicleId || undefined } : { vehicleId: state.vehicleId || undefined });
    // only what is known is claimed: the server has the location, or it has not
    const report = done => {
      if (done.shared) tell(`Location shared with ${done.shop.name}. Tell them where you are on the call as well, in case nobody is at the screen.`);
      else if (done.repeat) tell('The shop already has a breakdown from you from the last few minutes. Tell them where you are on the call.');
      else tell('Your location was not shared. Tell the shop where you are on the call.', true);
    };
    const offerWhatsApp = at => {
      const v = state.me.vehicles.find(x => x.id === state.vehicleId);
      const text = `Breakdown. I am here: https://maps.google.com/?q=${at.latitude.toFixed(5)},${at.longitude.toFixed(5)}${v ? `. Vehicle ${fmt.plate(v.regNo)}` : ''}.`;
      wa.href = `https://wa.me/${state.cfg.whatsapp}?text=${encodeURIComponent(text)}`;
      wa.hidden = false;
    };

    call.addEventListener('click', async e => {
      if (running) return;   // a second tap goes straight to the dialler
      e.preventDefault();
      running = true;
      tell('Finding where you are, then calling the shop.');
      const fix = locate();
      const at = await Promise.race([fix, new Promise(resolve => setTimeout(() => resolve(null), 4000))]);
      // pick the nearest shop here as well, so the right number is dialled even if the post below never lands
      if (at && state.cfg.shops.length > 1) {
        const far = s => Math.hypot(s.lat - at.latitude, (s.lng - at.longitude) * Math.cos(at.latitude * Math.PI / 180));
        setShop(state.cfg.shops.reduce((a, b) => (far(b) < far(a) ? b : a)));
      }
      const first = send(at);
      location.href = shopTel(shop);   // the call does not wait for the network
      try { report(await first); } catch (err) { tell('Your location was not shared. Tell the shop where you are on the call.', true); }
      if (at) offerWhatsApp(at);
      // the location came after the call had started: it is sent now and added to the same breakdown
      else fix.then(async late => {
        if (!late) return;
        offerWhatsApp(late);
        try { report(await send(late)); } catch (err) { /* the earlier line stands */ }
      });
      call.querySelector('.plate-txt').textContent = 'Call again';
      running = false;
    });
  }

  /* ---------- account ---------- */
  const dialog = $('#delete-dialog'), deleteForm = $('#delete-form');
  // on a shared phone or the shop's tablet nothing of this customer may stay on the page: the boxes are emptied,
  // what this tab remembered is dropped, and the page starts again from nothing
  function leave(note) {
    clearInterval(state.ticker);
    phoneForm.reset();
    codeForm.reset();
    for (const key of ['hta_pending', 'hta_sale', 'hta_ref']) stash.del(key);
    if (note) stash.set('hta_note', note);
    location.replace('/passport/');
  }
  document.addEventListener('click', e => {
    const out = e.target.closest('[data-signout]'), del = e.target.closest('[data-delete]');
    if (out) busy(out, async () => { try { await api('/api/auth/signout', { everywhere: out.dataset.signout === 'everywhere' }); } catch (err) { /* this device is cleared either way */ } leave('You are signed out.'); });
    if (del) { clearErrors(deleteForm); $('#del-confirm').value = ''; dialog.showModal(); }
  });
  $('#del-cancel').addEventListener('click', () => dialog.close());
  deleteForm.addEventListener('submit', e => {
    e.preventDefault();
    clearErrors(deleteForm);
    if ($('#del-confirm').value.trim().toUpperCase() !== 'DELETE') return fail(deleteForm, { field: 'confirm', message: 'Type DELETE to confirm.' });
    busy(e.submitter || $('button[type="submit"]', deleteForm), async () => {
      try {
        await api('/api/me/delete', { confirm: 'DELETE' });
        dialog.close();
        leave('Your data has been deleted.');
      } catch (err) {
        // deleting needs a sign-in less than ten minutes old
        fail(deleteForm, err.code === 'reauth' ? { message: 'For your safety, sign out, sign in again, and delete within ten minutes.' } : err);
      }
    });
  });

  /* ---------- start ---------- */
  async function load() {
    try {
      state.cfg = state.cfg || await config();
      for (const a of $$('[data-shop-call]')) a.href = shopTel(state.cfg.shops[0]);
      const me = await api('/api/me');
      state.me = me;
      if (!me.signedIn) {
        showSignIn();
        // back from reading the SMS on a phone that reloaded the page: straight to the code step, no second request
        let pending = null;
        try { pending = JSON.parse(stash.get('hta_pending') || 'null'); } catch (e) { /* start again */ }
        if (pending && /^\d{10}$/.test(pending.phone) && Date.now() - pending.at < 5 * 60000 && state.cfg.signIn !== 'off') { state.phone = pending.phone; showCodeStep(pending); }
        else stash.del('hta_pending');
        return;
      }
      stash.del('hta_pending');
      if (!me.hasPassport) {
        $('#empty-text').textContent = me.invited
          ? `Your invitation is saved against the number ending ${me.phoneLast4}. Buy tyres at the shop with this number and you and your friend each get a free ${me.referralService.toLowerCase()}.`
          : `No tyres have been registered against the number ending ${me.phoneLast4}.`;
        return show('empty');
      }
      inPlace(renderPassport);
      show('passport');
    } catch (err) {
      $('#error-text').textContent = err.message || 'Please try again.';
      show('error');
    }
  }

  $('#retry').addEventListener('click', () => load());
  // a page restored from the back-forward cache could show a signed-out customer's passport: load it fresh
  addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
  load().then(() => { if (state.cfg) setupBreakdown(); });
})();
