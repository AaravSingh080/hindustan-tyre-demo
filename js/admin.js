/* The owner's page: the numbers, staff accounts, stock by size, the old customer book, backups and the
   site's counts. Everything here is behind the owner's PIN; a member of staff who signs in is shown the door
   politely. Built with text nodes only, like the rest of the app pages. */
(function () {
  'use strict';
  const { $, $$, h, icon, fill, plate, fmt, api, show, fail, clearErrors, busy, say, config } = window.HTA;
  const state = { cfg: null, period: 'month', days: 30, importReady: false };

  const bytes = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
  const withVar = (el, name, value) => { el.style.setProperty(name, value); return el; };
  const sign = (title, iconName, ...kids) => h('section.sign', h('h2.sign-title', iconName ? icon(iconName) : null, title), kids);
  const fact = (label, value, small, wide) => [h('dt' + (wide ? '.wide' : ''), label), h('dd' + (wide ? '.wide' : ''), value, small ? h('small', small) : null)];
  const marker = (label, value, cls) => h('div.marker' + (cls ? '.' + cls : ''), h('dt', label), h('dd', typeof value === 'number' ? fmt.n(value) : value));
  const bars = (items, blue) => {
    const top = Math.max(1, ...items.map(i => i[1]));
    return h('ul.bars', ...items.map(([label, n, small]) => h('li', h('span.label', label, small ? h('small', small) : null), withVar(h('span.bar' + (blue ? '.is-blue' : ''), { 'aria-hidden': 'true' }), '--w', `${pct(n, top)}%`), h('span.n', fmt.n(n)))));
  };
  const call = async (path, body, opts) => {
    try { return await api(path, body, opts); } catch (e) {
      if (e.code === 'staff-signed-out') lock('Signed out. Enter the owner PIN.');
      if (e.code === 'owner-only') denied(null);
      throw e;
    }
  };
  const WHO = { owner: 'Owner', customer: 'A customer', system: 'The server', unknown: 'Someone', staff: 'Staff' };
  const who = actor => (actor.startsWith('staff:') ? actor.slice(6) : WHO[actor] || actor);
  const ACTIONS = {
    'sale.create': 'registered a sale', 'sale.void': 'removed a sale', 'visit.create': 'logged a visit', 'staff.login': 'signed in', 'staff.pin.wrong': 'typed a wrong PIN',
    'staff.create': 'added a staff account', 'staff.rename': 'renamed a staff account', 'staff.pin': 'set a new PIN for a staff account', 'staff.disable': 'switched a staff account off',
    'staff.enable': 'switched a staff account on', 'stock.count': 'counted stock', 'stock.remove': 'removed a size from the stock list', 'import.batch': 'imported rows from the old book',
    'backup.now': 'took a backup', 'backup.download': 'downloaded a copy of the database', 'customer.delete': 'deleted a customer\'s data', 'customer.expire': 'deleted customers idle for years',
    'vehicle.rename': 'corrected a vehicle number', 'grant.use': 'gave a free service', 'grant.unuse': 'undid a free service', 'reminders.on': 'switched reminders on', 'reminders.off': 'switched reminders off',
  };

  /* ---------- lock and unlock ---------- */
  const pinForm = $('#pin-form');
  function lock(message) {
    $('#lock').hidden = true;
    show('pin');
    $('#pin').value = '';
    $('.status', pinForm).textContent = message || '';
    if (state.cfg && state.cfg.demo) {
      $('#demo-pin').hidden = false;
      fill($('#demo-pin'), h('p', h('strong', 'Demo. '), `The owner's PIN is ${state.cfg.demo.staffPin}. `, ...(state.cfg.demo.staff || []).map(m => `${m.name} signs in with ${m.pin} and is shown the door here. `)));
    }
    $('#pin').focus();
  }
  function denied(w) {
    $('#lock').hidden = true;
    show('denied');
    fill($('#denied'),
      h('p', w ? `You are signed in as ${w.name}. ` : '', 'This page is for the owner. The staff desk is where sales and visits are entered.'),
      h('div.row',
        plate('Staff desk', { icon: 'wrench', href: '/staff/' }),
        plate('Sign in as owner', { kind: 'w', icon: 'lock-key', onclick: async () => { try { await api('/api/staff/logout', {}); } catch (e) { /* either way */ } lock(''); } })));
  }
  pinForm.addEventListener('submit', e => {
    e.preventDefault();
    clearErrors(pinForm);
    const pin = $('#pin').value.trim();
    if (!/^\d{4,12}$/.test(pin)) return fail(pinForm, { field: 'pin', message: 'Enter the owner PIN.' });
    busy(e.submitter || $('button[type="submit"]', pinForm), async () => {
      try {
        const done = await api('/api/staff/login', { pin });
        if (done.who && done.who.role !== 'owner') return denied(done.who);
        await openOffice();
      } catch (err) { $('#pin').value = ''; fail(pinForm, err.code === 'wrong-pin' || err.code === 'locked' ? { field: 'pin', message: err.message } : err); }
    });
  });
  $('#lock').addEventListener('click', async () => { try { await api('/api/staff/logout', {}); } catch (e) { /* locked here either way */ } lock('Locked.'); });

  /* ---------- the office ---------- */
  async function openOffice() {
    $('#lock').hidden = false;
    fill($('#who'), h('span.chip.chip-on', icon('users'), 'Owner'), h('span.muted', state.cfg && state.cfg.mode === 'demo' ? 'Demo data: everything here resets when the server restarts.' : 'Signed in with the owner PIN.'));
    show('office');
    const wanted = location.hash.replace('#', '');
    selectTab(loaders[wanted] ? wanted : 'overview');
  }

  const tabs = $$('[role="tab"]');
  const loaders = { overview: loadOverview, staff: loadStaff, stock: loadStock, import: loadImport, backup: loadBackup, stats: loadStats };
  function selectTab(name) {
    for (const t of tabs) {
      const on = t.id === 'tab-' + name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    }
    history.replaceState(null, '', '#' + name);
    const panel = $('#panel-' + name);
    if (!panel.childElementCount) fill(panel, h('section.sign', h('p', 'Loading.')));
    loaders[name](panel).catch(e => { if (e.code !== 'staff-signed-out' && e.code !== 'owner-only') fill(panel, h('section.sign', h('p.status.is-bad', e.message))); });
  }
  for (const t of tabs) {
    t.addEventListener('click', () => selectTab(t.id.slice(4)));
    t.addEventListener('keydown', e => {
      const i = tabs.indexOf(t), next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
      if (next) { e.preventDefault(); next.focus(); selectTab(next.id.slice(4)); }
    });
  }

  /* ---------- numbers ---------- */
  async function loadOverview(panel) {
    const o = await call('/api/admin/overview');
    $('#count-stock').textContent = o.lowStockCount || '';
    const PERIODS = [['today', 'Today'], ['week', '7 days'], ['month', '30 days'], ['year', '12 months']];
    const LABEL = { today: 'today', week: 'in the last 7 days', month: 'in the last 30 days', year: 'in the last 12 months' };
    const draw = () => {
      const p = o.periods[state.period], label = LABEL[state.period];
      fill(panel,
        sign('Sales', 'chart-bar',
          h('div.periods', ...PERIODS.map(([k, label]) => plate(label, { mini: true, kind: 'w', 'aria-pressed': String(state.period === k), onclick: () => { state.period = k; draw(); } }))),
          h('dl.markers',
            marker('Sales', p.sales), marker('Tyres', p.tyres), marker('Rupees billed', p.rupees),
            marker('Service visits', p.services), marker('New customers', p.newCustomers), marker('Reminders sent', p.remindersSent, 'is-blue'),
            marker('Breakdown calls', p.breakdowns, p.breakdowns ? 'is-warn' : '')),
          h('p.muted', `Sales and visits by the date they were fitted or logged, ${state.period === 'today' ? 'today' : 'since ' + fmt.day(p.since)}. Rupees only where a bill amount was typed in.`)),
        h('div.cols-2',
          sign(`Sizes sold, ${label}`, 'tire', p.topSizes.length ? bars(p.topSizes.map(r => [r.size, r.tyres, `${r.sales} ${r.sales === 1 ? 'sale' : 'sales'}`])) : h('p.empty', `No sales ${label}.`)),
          sign(`Tyres sold, ${label}`, null, p.topTyres.length ? bars(p.topTyres.map(r => [r.tyre, r.tyres]), true) : h('p.empty', `No sales ${label}.`))),
        h('div.cols-2',
          sign(`Who did what, ${label}`, 'users',
            p.byStaff.length ? withVar(h('ul.table', h('li.head', h('span', 'Person'), h('span', 'Sales'), h('span', 'Tyres'), h('span', 'Visits'), h('span')),
              ...p.byStaff.map(r => h('li', h('div.name', who(r.who)), h('div.num', fmt.n(r.sales)), h('div.num', fmt.n(r.tyres)), h('div.num', fmt.n(r.services || 0)), h('div')))), '--cols', '3')
              : h('p.empty', `Nothing entered ${label}.`),
            h('p.muted', 'Sales entered before staff accounts existed show as "Staff".')),
          sign('Customers', 'user-circle',
            h('dl.markers', marker('On the books', o.customers.total), marker('Vehicles', o.customers.vehicles), marker('Reminders on', `${pct(o.customers.remindersOk, o.customers.total)}%`, 'is-blue'), marker('Breakdowns unseen', o.unseenBreakdowns, o.unseenBreakdowns ? 'is-warn' : '')),
            o.lowStockCount ? h('p.note.note-alert', h('strong', `${o.lowStockCount} ${o.lowStockCount === 1 ? 'size is' : 'sizes are'} at or below minimum stock: `), o.lowStock.map(r => `${r.size} (${r.qty})`).join(', '), '. ', h('button.text-link', { type: 'button', onclick: () => selectTab('stock') }, 'Open the stock list', icon('arrow-right'))) : null)),
        sign('Recent activity', 'clock',
          o.recent.length ? h('ul.recent', ...o.recent.map(r => h('li', h('time', { datetime: new Date(r.at).toISOString() }, fmt.clock(r.at)), h('span', `${who(r.actor)} ${ACTIONS[r.action] || r.action.replace(/\./g, ' ')}`)))) : h('p.empty', 'Nothing yet.'),
          h('p.muted', 'The activity log names who did what, never a customer\'s number or vehicle. It is kept for a year.')));
    };
    draw();
  }

  /* ---------- staff accounts ---------- */
  function suggestPin() {
    const a = new Uint8Array(8);
    for (;;) {
      crypto.getRandomValues(a);
      const pin = Array.from(a, b => String(b % 10)).join('');
      if (!/^(\d)\1+$/.test(pin) && !'0123456789012345'.includes(pin) && !'9876543210987654'.includes(pin) && new Set(pin).size >= 4) return pin;
    }
  }
  async function loadStaff(panel) {
    const { staff } = await call('/api/admin/staff');
    const form = h('form.sign.form', { novalidate: true });
    const nameField = h('input', { id: 'st-name', name: 'name', type: 'text', autocomplete: 'off', maxlength: '40' });
    const pinField = h('input', { id: 'st-pin', name: 'pin', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '12' });
    fill(form,
      h('h2.sign-title', icon('user-plus'), 'Add a person'),
      h('p', 'Give them a PIN of 6 to 12 digits that is not a date or a pattern, and tell it to them in person. They type it at the staff desk; the desk then shows their name and every sale carries it.'),
      h('div.form-2',
        h('div.field', h('label', { for: 'st-name' }, 'Name'), h('div.fplate', h('span.plate-tab', { 'aria-hidden': 'true' }, icon('users')), nameField)),
        h('div.field', h('label', { for: 'st-pin' }, 'Their PIN'), h('div.fplate', h('span.plate-tab', { 'aria-hidden': 'true' }, icon('key')), pinField),
          h('p.hint', h('button.text-link', { type: 'button', onclick: () => { pinField.value = suggestPin(); } }, 'Suggest a PIN')))),
      h('p.status', { role: 'status' }),
      plate('Add this person', { icon: 'plus', type: 'submit' }));
    form.addEventListener('submit', e => {
      e.preventDefault();
      clearErrors(form);
      busy(e.submitter || $('button[type="submit"]', form), async () => {
        try {
          const done = await call('/api/admin/staff', { name: nameField.value, pin: pinField.value.trim() });
          say(`${done.member.name} can now sign in with their PIN.`);
          loadStaff(panel).catch(err => say(err.message, true));
        } catch (err) { fail(form, err); }
      });
    });

    const rowFor = m => {
      const li = h('li' + (m.active ? '' : '.is-off'));
      const normal = () => fill(li,
        h('div.name', m.name, h('small', `Added ${fmt.stamp(m.createdAt)}`)),
        h('div.num', m.lastLogin ? fmt.clock(m.lastLogin) : 'never', h('small', 'Last sign-in')),
        h('div', h('span.chip' + (m.active ? '.chip-on' : ''), m.active ? 'Active' : 'Off')),
        h('div.acts',
          plate('Rename', { mini: true, kind: 'w', onclick: () => edit('name') }),
          plate('New PIN', { mini: true, kind: 'w', onclick: () => edit('pin') }),
          plate(m.active ? 'Switch off' : 'Switch on', { mini: true, kind: m.active ? 'w' : undefined, onclick: e => busy(e.currentTarget, async () => {
            try { await call(`/api/admin/staff/${m.id}`, { active: !m.active }); say(m.active ? `${m.name} can no longer sign in.` : `${m.name} can sign in again.`); loadStaff(panel).catch(err => say(err.message, true)); } catch (err) { say(err.message, true); }
          }) })));
      const edit = what => {
        const f = h('form.rowform', { novalidate: true });
        const input = what === 'name'
          ? h('input', { id: `ed-${m.id}`, name: 'name', type: 'text', value: m.name, maxlength: '40', autocomplete: 'off' })
          : h('input', { id: `ed-${m.id}`, name: 'pin', type: 'text', inputmode: 'numeric', maxlength: '12', autocomplete: 'off' });
        fill(f,
          h('div.field', h('label', { for: `ed-${m.id}` }, what === 'name' ? `New name for ${m.name}` : `New PIN for ${m.name}`), h('div.fplate', h('span.plate-tab', { 'aria-hidden': 'true' }, icon(what === 'name' ? 'pencil-simple' : 'key')), input),
            what === 'pin' ? h('p.hint', 'Their old PIN stops working at once, on every device. ', h('button.text-link', { type: 'button', onclick: () => { input.value = suggestPin(); } }, 'Suggest a PIN')) : null),
          h('p.status', { role: 'status' }),
          h('div.row', plate('Save', { mini: true, type: 'submit', icon: 'check' }), plate('Cancel', { mini: true, kind: 'w', onclick: normal })));
        f.addEventListener('submit', e => {
          e.preventDefault();
          clearErrors(f);
          busy(e.submitter || $('button[type="submit"]', f), async () => {
            try { await call(`/api/admin/staff/${m.id}`, what === 'name' ? { name: input.value } : { pin: input.value.trim() }); say(what === 'name' ? 'Name changed.' : `New PIN set for ${m.name}.`); loadStaff(panel).catch(err => say(err.message, true)); } catch (err) { fail(f, err); }
          });
        });
        fill(li, f);
        input.focus();
      };
      normal();
      return li;
    };
    fill(panel,
      sign('Who can open the desk', 'users',
        h('p', 'Each person signs in with their own PIN, so sales and visits carry their name. The owner\'s PIN is set on the server (STAFF_PIN) and is not listed here; changing it signs everyone out.'),
        staff.length ? withVar(h('ul.table', h('li.head', h('span', 'Name'), h('span', 'Last sign-in'), h('span', 'Status'), h('span')), ...staff.map(rowFor)), '--cols', '2')
          : h('p.empty', 'No staff accounts yet. Until you add some, everyone shares the owner\'s PIN and the book cannot say who entered what.')),
      form);
  }

  /* ---------- stock ---------- */
  async function loadStock(panel) {
    const d = await call('/api/admin/stock');
    $('#count-stock').textContent = d.lowCount || '';
    const sizes = ((window.HTA_DATA && window.HTA_DATA.sizes) || []).filter(x => /^\d{2,3}\/\d{2,3}[\/-]\d{2}$|^\d{1,2}\.\d{2}-\d{2}$/.test(x)).map(x => x.replace(/^(\d+\/\d+)\/(\d+)$/, '$1 R$2'));
    const form = h('form.sign.form', { novalidate: true });
    const sizeIn = h('input', { id: 'sk-size', name: 'size', type: 'text', autocomplete: 'off', maxlength: '20', list: 'sk-sizes', placeholder: '185/65 R15' });
    const qtyIn = h('input', { id: 'sk-qty', name: 'qty', type: 'number', inputmode: 'numeric', min: '0', max: '100000', step: '1' });
    const minIn = h('input', { id: 'sk-min', name: 'minQty', type: 'number', inputmode: 'numeric', min: '0', max: '100000', step: '1', placeholder: '0' });
    fill(form,
      h('h2.sign-title', icon('plus'), 'Count a size'),
      h('p', 'Type the size, how many are on the shelf right now, and the number at which you want a warning. Counting a size that is already listed replaces its count.'),
      h('div.form-2',
        h('div.field', h('label', { for: 'sk-size' }, 'Size'), h('div.fplate', h('span.plate-tab', { 'aria-hidden': 'true' }, icon('tire')), sizeIn), h('datalist', { id: 'sk-sizes' }, ...sizes.map(x => h('option', { value: x })))),
        h('div.field', h('label', { for: 'sk-qty' }, 'On the shelf'), h('div.fplate', h('span.plate-tab', { 'aria-hidden': 'true' }, icon('package')), qtyIn)),
        h('div.field', h('label', { for: 'sk-min' }, 'Warn at'), h('div.fplate', h('span.plate-tab', { 'aria-hidden': 'true' }, icon('warning')), minIn))),
      h('p.status', { role: 'status' }),
      plate('Save the count', { icon: 'check', type: 'submit' }));
    form.addEventListener('submit', e => {
      e.preventDefault();
      clearErrors(form);
      busy(e.submitter || $('button[type="submit"]', form), async () => {
        try {
          const body = { size: sizeIn.value, qty: qtyIn.value === '' ? null : Number(qtyIn.value), minQty: minIn.value === '' ? null : Number(minIn.value) };
          const done = await call('/api/admin/stock', body);
          say(`${done.row.size}: ${done.row.qty} on the shelf, warning at ${done.row.minQty}.`);
          loadStock(panel).catch(err => say(err.message, true));
        } catch (err) { fail(form, err); }
      });
    });

    const rowFor = r => {
      const li = h('li' + (r.low ? '.is-low' : ''));
      const normal = () => fill(li,
        h('div.name', r.size, h('small', r.low ? (r.qty < 0 ? 'Count is off: more sold than counted' : 'At or below minimum') : `Counted ${fmt.stamp(r.updatedAt)}`)),
        h('div.num' + (r.low ? '.is-bad' : ''), String(r.qty), h('small', 'On shelf')),
        h('div.num', String(r.minQty), h('small', 'Warn at')),
        h('div.num', String(r.sold30), h('small', 'Sold, 30 d')),
        h('div.acts', plate('Recount', { mini: true, kind: 'w', onclick: edit }), plate('Movements', { mini: true, kind: 'w', onclick: moves })));
      const edit = () => {
        const f = h('form.rowform', { novalidate: true });
        const safe = r.key.replace(/[^A-Za-z0-9]/g, '') + '-' + d.rows.indexOf(r);
        const q = h('input', { id: `sq-${safe}`, name: 'qty', type: 'number', inputmode: 'numeric', min: '0', max: '100000', step: '1', value: String(Math.max(0, r.qty)) });
        const mn = h('input', { id: `sm-${safe}`, name: 'minQty', type: 'number', inputmode: 'numeric', min: '0', max: '100000', step: '1', value: String(r.minQty) });
        fill(f,
          h('div.form-2',
            h('div.field', h('label', { for: `sq-${safe}` }, `${r.size} on the shelf now`), h('div.fplate', h('span.plate-tab', { 'aria-hidden': 'true' }, icon('package')), q)),
            h('div.field', h('label', { for: `sm-${safe}` }, 'Warn at'), h('div.fplate', h('span.plate-tab', { 'aria-hidden': 'true' }, icon('warning')), mn))),
          h('p.status', { role: 'status' }),
          h('div.row', plate('Save', { mini: true, type: 'submit', icon: 'check' }), plate('Cancel', { mini: true, kind: 'w', onclick: normal }),
            h('button.text-link', { type: 'button', onclick: e => busy(e.currentTarget, async () => { try { await call('/api/admin/stock/remove', { size: r.size }); say(`${r.size} removed from the list.`); loadStock(panel).catch(err => say(err.message, true)); } catch (err) { fail(f, err); } }) }, 'Remove from the list')));
        f.addEventListener('submit', e => {
          e.preventDefault();
          clearErrors(f);
          busy(e.submitter || $('button[type="submit"]', f), async () => {
            try { await call('/api/admin/stock', { size: r.size, qty: Number(q.value), minQty: Number(mn.value) }); say(`${r.size} recounted.`); loadStock(panel).catch(err => say(err.message, true)); } catch (err) { fail(f, err); }
          });
        });
        fill(li, f);
        q.focus();
      };
      const moves = async () => {
        let list;
        try { list = (await call('/api/admin/stock/moves', { size: r.size })).moves; } catch (err) { return say(err.message, true); }
        const REASON = { sale: 'sold', void: 'sale removed', count: 'counted' };
        fill(li, h('div.rowform',
          h('p', h('strong', `${r.size}: `), list.length ? 'the last movements, newest first.' : 'no movements yet.'),
          list.length ? h('ul.recent', ...list.map(m => h('li', h('time', fmt.clock(m.at)), h('span', `${m.delta > 0 ? '+' : ''}${m.delta}, ${REASON[m.reason] || m.reason}${m.saleId ? ` (sale ${m.saleId})` : ''} by ${who(m.by || 'unknown')}`)))) : null,
          plate('Close', { mini: true, kind: 'w', onclick: normal })));
      };
      normal();
      return li;
    };
    fill(panel,
      sign('On the shelf', 'package',
        h('p', 'Every sale registered at the desk takes its tyres off these counts, and a removed sale puts them back. A size at or below its minimum is marked here, on the Numbers tab, and at the desk when the sale that got it there is saved.'),
        d.rows.length ? withVar(h('ul.table', h('li.head', h('span', 'Size'), h('span', 'On shelf'), h('span', 'Warn at'), h('span', 'Sold, 30 days'), h('span')), ...d.rows.map(rowFor)), '--cols', '3')
          : h('p.empty', 'No sizes counted yet. Add the sizes you keep, with how many are on the shelf.')),
      d.untracked.length ? sign('Sold lately but not counted', 'funnel',
        h('p', 'These sizes were sold in the last 30 days but are not on the list. Tap one to count it.'),
        h('div.picks', ...d.untracked.map(u => plate(`${u.key} (${u.sold30} sold)`, { mini: true, kind: 'w', onclick: () => { sizeIn.value = u.key; qtyIn.value = ''; qtyIn.focus(); form.scrollIntoView({ block: 'start' }); } })))) : null,
      form);
  }

  /* ---------- the old customer book ---------- */
  const FIELDS = [
    ['phone', 'Mobile number', true, ['phone', 'mobile', 'mobile no', 'mobile number', 'contact', 'contact no', 'phone no', 'phone number', 'whatsapp', 'number', 'mob']],
    ['regNo', 'Vehicle number', true, ['vehicle', 'vehicle no', 'vehicle number', 'reg', 'reg no', 'registration', 'registration no', 'plate', 'number plate', 'gaadi', 'car no', 'vehicle reg', 'veh no']],
    ['tyre', 'Tyre (brand and model)', true, ['tyre', 'tyre name', 'tyre model', 'brand', 'brand model', 'item', 'product', 'description', 'tire', 'model']],
    ['size', 'Size', true, ['size', 'tyre size', 'tire size']],
    ['qty', 'How many', true, ['qty', 'quantity', 'nos', 'no of tyres', 'tyres', 'count', 'pcs', 'pieces', 'no']],
    ['fittedOn', 'Date fitted', true, ['date', 'fitted on', 'fitted_on', 'fitted', 'fitting date', 'bill date', 'sale date', 'invoice date', 'dt']],
    ['odometerKm', 'Odometer km', false, ['odometer', 'odometer km', 'odometer_km', 'km', 'kms', 'reading', 'mileage', 'odo']],
    ['billNo', 'Bill number', false, ['bill', 'bill no', 'bill_no', 'bill number', 'invoice', 'invoice no', 'receipt', 'receipt no']],
    ['amount', 'Amount in rupees', false, ['amount', 'amount rupees', 'amount_rupees', 'total', 'price', 'rs', 'rupees', 'value', 'amt']],
    ['remindersOk', 'WhatsApp reminders yes/no', false, ['reminders', 'reminders_ok', 'reminder', 'whatsapp ok', 'consent', 'opt in', 'optin']],
  ];
  const normHead = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
    const delim = [',', ';', '\t', '|'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(c => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function toDay(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return iso(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(s))) {
      let d = +m[1], mo = +m[2];
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];   // written month first
      return iso(y, mo, d);
    }
    if ((m = /^(\d{1,2})[ \/.-]([A-Za-z]{3,9})[ \/.,-]*(\d{2,4})$/.exec(s))) {
      const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], mo, +m[1]);
    }
    if (/^\d{5}$/.test(s)) { const n = +s; if (n > 20000 && n < 70000) return new Date(Date.UTC(1899, 11, 30) + n * 86400e3).toISOString().slice(0, 10); }   // an Excel serial date
    return s;   // let the server say what is wrong with it
  }
  const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : 'not a date');
  // the first number in the cell: '42,350 km' is 42350, 'Rs. 21,400.50' is 21400.5
  const firstNumber = v => { const m = /\d[\d,]*(?:\.\d+)?/.exec(String(v || '')); return m ? Number(m[0].replace(/,/g, '')) : null; };
  const toInt = v => { const n = firstNumber(v); return n == null ? null : Math.round(n); };
  const toMoney = v => firstNumber(v);
  const toBool = v => (/^(y|yes|haan|ha|true|1|on|ok)$/i.test(String(v || '').trim()) ? true : /^(n|no|nahi|false|0|off)$/i.test(String(v || '').trim()) ? false : null);
  function rowObject(cells, map) {
    const get = k => (map[k] == null ? '' : String(cells[map[k]] == null ? '' : cells[map[k]]).trim());
    const out = {
      phone: get('phone').replace(/[^\d]/g, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, ''),
      regNo: get('regNo').toUpperCase().replace(/[\s\-.]/g, ''),
      tyre: get('tyre'), size: get('size'), qty: toInt(get('qty')), fittedOn: toDay(get('fittedOn')),
    };
    if (map.odometerKm != null && get('odometerKm') !== '') out.odometerKm = toInt(get('odometerKm'));
    if (map.billNo != null && get('billNo') !== '') out.billNo = get('billNo');
    if (map.amount != null && get('amount') !== '') out.amount = toMoney(get('amount'));
    if (map.remindersOk != null && toBool(get('remindersOk')) != null) out.remindersOk = toBool(get('remindersOk'));
    for (const k of Object.keys(out)) if (out[k] === '' || out[k] === null) delete out[k];
    return out;
  }
  function quickCheck(o) {
    if (!o.phone) return 'no mobile number';
    if (!/^\d{10}$/.test(o.phone)) return 'the mobile number is not 10 digits';
    if (!o.regNo) return 'no vehicle number';
    if (!o.tyre) return 'no tyre';
    if (!o.size) return 'no size';
    if (!o.qty) return 'how many tyres is missing';
    if (!o.fittedOn || !/^\d{4}-\d{2}-\d{2}$/.test(o.fittedOn)) return 'the date could not be read';
    return null;
  }

  async function loadImport(panel) {
    if (state.importReady) return;
    state.importReady = true;
    const demo = state.cfg && state.cfg.mode === 'demo';
    const mapSign = h('section.sign', { hidden: true }), previewSign = h('section.sign', { hidden: true }), resultSign = h('section.sign', { hidden: true });
    const fileIn = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Choose the CSV file' });
    let rows = [], headers = [], map = {};

    fill(panel,
      sign('Bring in the old customer book', 'file-csv',
        h('p', 'One row per tyre sale: the mobile number, the vehicle number, the tyre, its size, how many, and the date. Each row becomes a sale in the passport on its own date, so the customer can sign in and see it and reminders can be worked out.'),
        h('p', h('strong', '1. '), 'In Excel or Google Sheets, save the sheet as CSV (comma separated). ', h('a.text-link', { href: '/assets/templates/customer-book.csv', download: 'customer-book.csv' }, 'Download the example file', icon('download-simple')), '.'),
        h('p', h('strong', '2. '), 'Choose the file. Nothing is sent until you press Import.'),
        h('p', h('strong', '3. '), 'Check that the columns matched, look at the preview, then import. Rows already in the book are skipped; rows that cannot be read are listed with the reason and the rest still go in.'),
        demo ? h('p.note', h('strong', 'Demo: '), 'only sample numbers starting with 555 are accepted, so no real person\'s number can be typed into the demo. The example file uses them.') : null,
        h('p.note', 'Reminders are switched on only where a column says yes. Nothing is sent to anyone by importing.'),
        h('div.file-plate', plate('Choose the CSV file', { icon: 'upload-simple', tabindex: '-1' }), fileIn)),
      mapSign, previewSign, resultSign);

    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return say('That file is larger than 8 MB. Split the sheet into parts.', true);
      const text = await f.text();
      const all = parseCsv(text);
      if (all.length < 2) return say('That file has no rows under its heading line.', true);
      headers = all[0].map(x => String(x).trim());
      rows = all.slice(1);
      map = {};
      for (const [key, , , aliases] of FIELDS) {
        let i = headers.findIndex(hd => aliases.includes(normHead(hd)));
        if (i < 0) i = headers.findIndex(hd => aliases.some(a => a.length >= 4 && normHead(hd).includes(a)));
        if (i >= 0 && !Object.values(map).includes(i)) map[key] = i;
      }
      resultSign.hidden = true;
      drawMapping();
      drawPreview();
      mapSign.scrollIntoView({ block: 'start' });
    });

    function drawMapping() {
      mapSign.hidden = false;
      fill(mapSign,
        h('h2.sign-title', icon('list-checks'), `${f(rows.length)} in the file`),
        h('p', 'Each thing the passport needs, and the column it was found in. Change any that matched wrongly.'),
        h('div.mapping', ...FIELDS.map(([key, label, required]) => {
          const sel = h('select', { id: 'map-' + key }, h('option', { value: '' }, required ? 'not in the file' : 'leave out'), ...headers.map((hd, i) => h('option', { value: String(i), selected: map[key] === i }, hd || `column ${i + 1}`)));
          sel.addEventListener('change', () => { if (sel.value === '') delete map[key]; else map[key] = Number(sel.value); drawPreview(); });
          return h('label', { for: 'map-' + key }, h('span', label, required ? h('span.need', ' needed') : ''), sel);
        })));
    }
    const f = n => `${fmt.n(n)} ${n === 1 ? 'row' : 'rows'}`;
    function drawPreview() {
      previewSign.hidden = false;
      const missing = FIELDS.filter(([key, , required]) => required && map[key] == null).map(x => x[1]);
      const objects = rows.map(cells => rowObject(cells, map));
      const problems = objects.map(quickCheck);
      const ready = problems.filter(p => !p).length;
      const sample = rows.slice(0, 8);
      const cols = FIELDS.filter(([key]) => map[key] != null);
      const importBtn = plate(`Import ${f(ready)}`, { icon: 'upload-simple', onclick: e => busy(e.currentTarget, () => runImport(objects, problems)) });
      if (!ready || missing.length) importBtn.disabled = true;
      fill(previewSign,
        h('h2.sign-title', icon('funnel'), 'Preview'),
        missing.length ? h('p.note.note-alert', h('strong', 'Still needed: '), `${missing.join(', ')}. Pick the columns above.`) : null,
        h('dl.markers', marker('Rows', rows.length), marker('Ready', ready), marker('With problems', rows.length - ready, rows.length - ready ? 'is-warn' : '')),
        h('div.preview', h('table',
          h('thead', h('tr', h('th', 'Row'), ...cols.map(([, label]) => h('th', label)), h('th', 'Problem'))),
          h('tbody', ...sample.map((cells, i) => {
            const o = objects[i];
            return h('tr', h('td', String(i + 2)), ...cols.map(([key]) => h('td', key === 'fittedOn' ? String(o.fittedOn || '') : key === 'remindersOk' ? (o.remindersOk === true ? 'yes' : o.remindersOk === false ? 'no' : '') : String(o[key] == null ? '' : o[key]))), h('td' + (problems[i] ? '.bad' : ''), problems[i] || ''));
          })))),
        rows.length > sample.length ? h('p.muted', `Showing the first ${sample.length} rows. Row numbers are as in the spreadsheet, with the heading as row 1.`) : null,
        h('p.status', { role: 'status' }),
        importBtn);
    }
    async function runImport(objects, problems) {
      const status = $('.status', previewSign);
      const todo = objects.map((o, i) => ({ o, i })).filter(x => !problems[x.i]);
      const failed = objects.map((o, i) => (problems[i] ? { row: i + 2, reason: problems[i] } : null)).filter(Boolean);
      let added = 0, dup = 0;
      const bar = withVar(h('div.progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(todo.length), 'aria-valuenow': '0' }, h('i')), '--w', '0%');
      resultSign.hidden = false;
      fill(resultSign, h('h2.sign-title', icon('upload-simple'), 'Importing'), bar, h('p.muted', { id: 'imp-prog' }, `0 of ${todo.length}`));
      resultSign.scrollIntoView({ block: 'start' });
      // a batch that fails as a whole is retried in halves, so one bad row cannot sink twenty-four good ones;
      // a busy answer waits; a sign-out stops the run
      let stopped = false;
      const send = async batch => {
        if (stopped) { for (const x of batch) failed.push({ row: x.i + 2, reason: 'Not imported: signed out before this row.' }); return; }
        let results;
        try { results = (await call('/api/admin/import', { rows: batch.map(x => x.o) })).results; } catch (e) {
          if (e.code === 'staff-signed-out' || e.code === 'owner-only') { stopped = true; return send(batch); }
          if (e.code === 'slow-down') { await new Promise(r => setTimeout(r, Math.min(e.retryAfterMs || 15000, 60000))); return send(batch); }
          if (batch.length > 1) { await send(batch.slice(0, Math.ceil(batch.length / 2))); return send(batch.slice(Math.ceil(batch.length / 2))); }
          failed.push({ row: batch[0].i + 2, reason: e.message });
          return;
        }
        results.forEach((r, j) => { if (r.ok && r.duplicate) dup++; else if (r.ok) added++; else failed.push({ row: batch[j].i + 2, reason: r.error }); });
      };
      for (let at = 0; at < todo.length; at += 25) {
        await send(todo.slice(at, at + 25));
        const done = Math.min(at + 25, todo.length);
        withVar(bar, '--w', `${pct(done, todo.length)}%`);
        bar.setAttribute('aria-valuenow', String(done));
        $('#imp-prog').textContent = `${done} of ${todo.length}`;
      }
      failed.sort((a, b) => a.row - b.row);
      const failCsv = () => {
        const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const lines = [[...headers, 'problem'].map(esc).join(',')];
        for (const x of failed) lines.push([...(rows[x.row - 2] || []), x.reason].map(esc).join(','));
        const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
        const a = h('a', { href: url, download: 'rows-to-fix.csv' });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      };
      fill(resultSign,
        h('h2.sign-title', icon('check-circle'), 'Done'),
        h('dl.markers', marker('Added', added), marker('Already in the book', dup, 'is-blue'), marker('Could not be read', failed.length, failed.length ? 'is-warn' : '')),
        failed.length ? h('ul.fails', ...failed.slice(0, 200).map(x => h('li', h('b', `Row ${x.row}: `), x.reason))) : h('p', 'Every row went in.'),
        failed.length > 200 ? h('p.muted', `Showing the first 200 of ${failed.length} problems.`) : null,
        h('div.row', failed.length ? plate('Download the rows to fix', { kind: 'w', icon: 'download-simple', onclick: failCsv }) : null, plate('See the numbers', { icon: 'chart-bar', onclick: () => selectTab('overview') })),
        h('p.muted', 'Fix the rows in the spreadsheet and import that file again: rows already added are skipped.'));
      status.textContent = '';
    }
  }

  /* ---------- backup ---------- */
  async function loadBackup(panel) {
    const b = await call('/api/admin/backup');
    const nowBtn = plate('Back up now', { icon: 'database', onclick: e => busy(e.currentTarget, async () => {
      try {
        const done = await call('/api/admin/backup/now', {});
        say(done.error ? `Copy taken, but the off-site upload failed: ${done.error}` : done.sent ? 'Copy taken and sent off-site.' : 'Copy taken.', !!done.error);
        loadBackup(panel).catch(err => say(err.message, true));
      } catch (err) { say(err.message, true); }
    }) });
    if (b.demo) nowBtn.disabled = true;
    const off = b.offsite;
    fill(panel,
      sign('Copies of the customer book', 'hard-drives',
        b.demo ? h('p.note', h('strong', 'Demo: '), 'the sample data lives in memory and is thrown away when the server stops, so there is no file to copy. On a live site a copy is taken every day and seven are kept.')
          : h('dl.facts',
            ...fact('Database', `${fmt.n(b.database.customers)} customers`, bytes(b.database.bytes)),
            ...fact('Last daily copy', b.local.lastAt ? fmt.clock(b.local.lastAt) : 'none yet', `${b.local.files.length} kept in ${b.local.dir}`)),
        b.local.files.length ? h('ul.files', ...b.local.files.map(x => h('li', h('span', x.name), h('span', bytes(x.bytes))))) : null,
        h('div.row', nowBtn, plate('Download a copy', { kind: 'w', icon: 'download-simple', href: '/api/admin/backup/download' })),
        h('p.note', 'A downloaded copy holds every customer\'s number and vehicle. Keep it where only you can open it, and delete old copies. Every download is written in the activity log.')),
      sign('Off-site copy', 'cloud-arrow-up',
        off.configured ? h('dl.facts',
          ...fact('Goes to', `${off.where.bucket}`, `${off.where.endpoint}, folder ${off.where.prefix || '(top level)'}`),
          ...fact('Last sent', off.lastAt ? fmt.clock(off.lastAt) : 'not yet', off.lastName || (off.lastTriedAt ? `Last tried ${fmt.clock(off.lastTriedAt)}` : 'Sent once a day, after the daily copy')),
          ...(off.lastError ? fact('Last problem', off.lastError, off.lastTriedAt ? fmt.clock(off.lastTriedAt) : null, true) : []))
          : [h('p', 'Not set up. Once a day the copy can be sent to a storage bucket outside this server: Amazon S3, Cloudflare R2, Backblaze B2, Wasabi or any S3-compatible service. If the server\'s disk is lost, the book is not.'),
            h('p', 'On the host, set these in the server\'s settings and restart:'),
            h('code.cmd', 'BACKUP_S3_BUCKET=  BACKUP_S3_KEY=  BACKUP_S3_SECRET=  and BACKUP_S3_REGION (AWS) or BACKUP_S3_ENDPOINT (others)'),
            h('p.muted', 'The key and secret never appear on this page. Details are in .env.example beside the server.')]),
      sign('Putting a copy back', 'arrow-counter-clockwise',
        h('p', 'Stop the server, run this on the server with the copy you want, then start it again. The current database is kept beside it, named before-restore, in case you change your mind.'),
        h('code.cmd', 'node server/restore.js /path/to/passport-2026-10-07.sqlite'),
        h('p.muted', 'A copy from a newer version of the server is refused rather than guessed at. Copies from the bucket must be downloaded to the server first.')));
  }

  /* ---------- the site's counts ---------- */
  async function loadStats(panel) {
    const d = await call(`/api/admin/stats/${state.days}`);
    const t = k => d.totals[k] || 0;
    const steps = [['Opened Find my tyres', t('page.tyres')], ['Answered the first question', t('tyres.step.2')], ['Answered the second', t('tyres.step.3')], ['Saw their tyres', t('tyres.found')], ['Went on to the shop', t('tyres.go')]];
    const start = steps[0][1];
    const funnel = h('ul.funnel', ...steps.map(([label, n], i) => {
      const prev = i ? steps[i - 1][1] : n;
      const drop = prev - n;
      return h('li', withVar(h('span.step', label, h('small', `${fmt.n(n)}${start ? `, ${pct(n, start)}%` : ''}`)), '--w', `${pct(n, start)}%`),
        i ? h('span.drop' + (prev && drop / prev > 0.5 ? '.is-bad' : ''), drop > 0 ? `${fmt.n(drop)} left` : '') : h('span.drop', ''));
    }));
    // by day, or by week when the range is long
    const byDay = new Map();
    for (const r of d.rows) if (r.key === 'page.home' || r.key === 'page.tyres') { const k = state.days > 30 ? weekOf(r.day) : r.day; byDay.set(k, (byDay.get(k) || 0) + r.n); }
    const days = [...byDay].sort(([a], [b]) => (a < b ? -1 : 1));
    fill(panel,
      sign('Find my tyres', 'funnel',
        h('div.periods', ...[7, 30, 90].map(n => plate(`${n} days`, { mini: true, kind: 'w', 'aria-pressed': String(state.days === n), onclick: () => { state.days = n; loadStats(panel).catch(err => say(err.message, true)); } }))),
        start ? funnel : h('p.empty', 'Nothing counted yet. Counts appear as people use the site.'),
        h('p.muted', `${fmt.n(t('tyres.help'))} asked for help on WhatsApp from that page. "Left" is how many fewer people reached a step than the one before.`)),
      h('div.cols-2',
        sign('Pages and tools', 'chart-line-up',
          h('dl.markers', marker('Home page', t('page.home')), marker('Find my tyres', t('page.tyres')), marker('Tyre passport', t('page.passport'), 'is-blue'),
            marker('Home finder used', t('finder.vehicle') + t('finder.search')), marker('Chat opened', t('chat.open')), marker('Questions asked', t('chat.ask') + t('chat.quick'), 'is-blue'))),
        sign(state.days > 30 ? 'Page views by week' : 'Page views by day', null,
          days.length ? bars(days.map(([k, n]) => [state.days > 30 ? `Week of ${fmt.day(k)}` : fmt.day(k), n])) : h('p.empty', 'Nothing yet.'))),
      sign('How this is counted', 'info',
        h('p', 'No cookies and no identifiers. A page tells the server that a thing happened (a step answered, the chat opened) and the server adds one to that day\'s count. Nothing about the visitor is kept, so two visits by one person count twice, and the counts cannot be joined to a customer.'),
        h('p.muted', 'Browsers that ask not to be tracked (Do Not Track or Global Privacy Control) are left out entirely. Counts are kept for 400 days.')));
  }
  const weekOf = day => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

  /* ---------- start ---------- */
  (async () => {
    try { state.cfg = await config(); } catch (e) { state.cfg = null; }
    try {
      const st = await api('/api/staff/status');
      if (!st.who || st.who.role !== 'owner') return denied(st.who);
      await openOffice();
    } catch (e) { lock(e.code && e.code !== 'staff-signed-out' && e.code !== 'not-set-up' ? e.message : ''); }
  })();
  addEventListener('hashchange', () => { const name = location.hash.replace('#', ''); if (loaders[name] && !$('[data-view="office"]').hidden) selectTab(name); });
})();
