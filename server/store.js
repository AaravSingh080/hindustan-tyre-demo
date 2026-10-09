'use strict';

/* Customers, vehicles, sales, visits, the visit card and referrals. Every rule about the data lives here,
   so the HTTP layer, the demo seed and the tests all go through the same code. */

const crypto = require('node:crypto');
const { tx, audit, DAY_MS } = require('./db');
const est = require('./estimate');

// something the person at the keyboard can put right; `field` says where
class Problem extends Error {
  constructor(field, message, extra) { super(message); this.field = field; this.extra = extra || null; }
}
// an unusual value: refused once, saved if the same request comes back with confirm: true
const unusual = (field, message) => new Problem(field, message, { canConfirm: true });

const rand = n => crypto.randomBytes(n).toString('base64url');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0 O 1 I L: these get read out over a counter
const newReferralCode = () => Array.from({ length: 8 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
const km = n => n.toLocaleString('en-IN');

function serviceNames(cfg) {
  const names = new Map();
  for (const sv of [...cfg.settings.rewards.services, ...cfg.settings.reminders.services]) if (!names.has(sv.key)) names.set(sv.key, sv.name);
  return names;
}

const todayFor = (cfg, now) => est.today(now, cfg.settings.shop.utcOffsetMinutes);
const customerByPhone = (db, phone) => db.q('SELECT * FROM customers WHERE phone = ?').get(phone);
const customerById = (db, id) => db.q('SELECT * FROM customers WHERE id = ?').get(id);
const withServices = v => ({ ...v, services: JSON.parse(v.services) });

function ensureCustomer(db, phone, now) {
  const found = customerByPhone(db, phone);
  if (found) return found;
  for (let i = 0; ; i++) {
    try {
      db.q('INSERT INTO customers (phone, stop_token, referral_code, created_at) VALUES (?, ?, ?, ?)').run(phone, rand(18), newReferralCode(), now);
      return customerByPhone(db, phone);
    } catch (e) {
      if (i >= 4 || !/UNIQUE/.test(String(e.message))) throw e;   // a referral code collision: draw again
    }
  }
}

/* ---------- reminders consent ---------- */

/* by: 'customer' or 'staff'. Stopping is one way from the shop's side: once reminders have been stopped, by the
   customer or at the customer's request, only the customer, signed in, can turn them back on. */
function setReminders(db, cfg, customer, on, by, now) {
  if (on) {
    if (by === 'staff' && customer.stopped_at) return 'stopped';
    db.q('UPDATE customers SET reminders_ok = 1, consent_at = ?, consent_by = ?, consent_notice = ?, stopped_at = NULL WHERE id = ?').run(now, by, cfg.settings.privacy.noticeVersion, customer.id);
    audit(db, now, by, 'reminders.on', { customer: customer.id, notice: cfg.settings.privacy.noticeVersion });
    return 'on';
  }
  db.q('UPDATE customers SET reminders_ok = 0, stopped_at = ? WHERE id = ?').run(now, customer.id);
  audit(db, now, by, 'reminders.off', { customer: customer.id });
  return 'off';
}

const consentOf = c => (c.reminders_ok ? 'yes' : c.stopped_at ? 'stopped' : 'no');

/* ---------- visit card ---------- */

/* One stamp per day the customer comes in, and only for visits entered within a week of happening, so typing in
   old records never hands out rewards. Called before the visit row is written; returns what that row should
   carry and any free service the stamp earned. */
function stamp(db, cfg, customerId, day, counts, now) {
  if (!counts || db.q('SELECT 1 FROM visits WHERE customer_id = ? AND visited_on = ? AND stamped = 1 LIMIT 1').get(customerId, day)) return { stamped: 0, earned: null };
  const r = cfg.settings.rewards;
  const n = db.q('SELECT COUNT(*) AS n FROM visits WHERE customer_id = ? AND stamped = 1').get(customerId).n + 1;
  const place = ((n - 1) % r.cardVisits) + 1, round = Math.floor((n - 1) / r.cardVisits);
  const step = r.card.find(c => c.atVisit === place);
  if (!step) return { stamped: 1, earned: null };
  const done = db.q("INSERT OR IGNORE INTO grants (customer_id, service, source, ref, earned_at) VALUES (?, ?, 'card', ?, ?)").run(customerId, step.service, `${round}:${place}`, now);
  return { stamped: 1, earned: done.changes ? serviceNames(cfg).get(step.service) : null };
}

function cardView(db, cfg, customerId) {
  const r = cfg.settings.rewards, names = serviceNames(cfg);
  const stamps = db.q('SELECT COUNT(*) AS n FROM visits WHERE customer_id = ? AND stamped = 1').get(customerId).n;
  // a full card stays full until the next visit starts a new one
  const place = stamps === 0 ? 0 : ((stamps - 1) % r.cardVisits) + 1;
  const grants = db.q('SELECT * FROM grants WHERE customer_id = ? ORDER BY earned_at DESC, id DESC').all(customerId);
  const view = g => ({ id: g.id, name: names.get(g.service) || g.service, source: g.source, earnedAt: g.earned_at, usedAt: g.used_at });
  return {
    stamps,
    cardVisits: r.cardVisits,
    place,
    steps: [...r.card].sort((a, b) => a.atVisit - b.atVisit).map(c => ({ atVisit: c.atVisit, name: names.get(c.service), reached: place >= c.atVisit })),
    available: grants.filter(g => !g.used_at).map(view),
    used: grants.filter(g => g.used_at).slice(0, 10).map(view),
  };
}

function useGrant(db, grantId, now, by) {
  const g = db.q('SELECT * FROM grants WHERE id = ?').get(grantId);
  if (!g) throw new Problem('grant', 'That free service was not found.');
  if (!db.q('UPDATE grants SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, grantId).changes) throw new Problem('grant', 'That free service has already been used.');
  audit(db, now, by || 'staff', 'grant.use', { grant: grantId, customer: g.customer_id });
  return g.customer_id;
}

// a wrong tap can be taken back for ten minutes
function unuseGrant(db, grantId, now, by) {
  const g = db.q('SELECT * FROM grants WHERE id = ?').get(grantId);
  if (!g) throw new Problem('grant', 'That free service was not found.');
  if (!g.used_at || now - g.used_at > 10 * 60e3) throw new Problem('grant', 'This can only be undone within ten minutes of marking it used.');
  db.q('UPDATE grants SET used_at = NULL WHERE id = ?').run(grantId);
  audit(db, now, by || 'staff', 'grant.unuse', { grant: grantId, customer: g.customer_id });
  return g.customer_id;
}

/* ---------- refer a friend ---------- */

const referrerByCode = (db, code) => db.q('SELECT * FROM customers WHERE referral_code = ?').get(code);

// remembers who invited this number. The first invitation wins; nothing is earned until the friend buys.
function linkReferral(db, cfg, friendPhone, referrer, now) {
  if (cfg.settings.rewards.referral.maxPerYear < 1) return 'off';
  if (referrer.phone === friendPhone) return 'self';
  if (db.q('SELECT 1 FROM referrals WHERE friend_phone = ?').get(friendPhone)) return 'exists';
  const friend = customerByPhone(db, friendPhone);
  if (friend && db.q('SELECT 1 FROM sales WHERE customer_id = ? LIMIT 1').get(friend.id)) return 'not-new';
  db.q('INSERT INTO referrals (referrer_id, friend_phone, created_at) VALUES (?, ?, ?)').run(referrer.id, friendPhone, now);
  return 'linked';
}

/* Called once, on the friend's first purchase. A second SIM is not a friend: if the vehicle is already known to
   the shop under another number, nobody earns anything. Otherwise the friend always gets theirs, and the
   referrer gets theirs up to the yearly cap. */
function convertReferral(db, cfg, friend, regNo, now) {
  const rule = cfg.settings.rewards.referral, service = serviceNames(cfg).get(rule.service);
  if (rule.maxPerYear < 1) return null;   // referrals are switched off: an old invitation earns nobody anything
  const ref = db.q('SELECT * FROM referrals WHERE friend_phone = ? AND converted_at IS NULL').get(friend.phone);
  if (!ref) return null;
  if (db.q('SELECT 1 FROM vehicles WHERE reg_no = ? AND customer_id <> ? LIMIT 1').get(regNo, friend.id)) {
    db.q('DELETE FROM referrals WHERE id = ?').run(ref.id);
    audit(db, now, 'system', 'referral.void', { referrer: ref.referrer_id, friend: friend.id });
    return { service, friendGot: false, referrerGot: false, why: 'vehicle-known' };
  }
  const lastYear = db.q('SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND converted_at > ?').get(ref.referrer_id, now - 365 * DAY_MS).n;
  db.q('UPDATE referrals SET converted_at = ? WHERE id = ?').run(now, ref.id);
  const grant = (customerId, tag) => db.q("INSERT OR IGNORE INTO grants (customer_id, service, source, ref, earned_at) VALUES (?, ?, 'referral', ?, ?)").run(customerId, rule.service, tag, now).changes > 0;
  const friendGot = grant(friend.id, 'welcome');
  // a reward already used for this friend's first, since removed, sale moves to the corrected one
  const carried = db.q("SELECT id FROM grants WHERE customer_id = ? AND source = 'referral' AND ref LIKE 'friend:carry:%' ORDER BY id LIMIT 1").get(ref.referrer_id);
  if (carried) db.q('UPDATE grants SET ref = ? WHERE id = ?').run(`friend:${friend.id}`, carried.id);
  const referrerGot = !carried && lastYear < rule.maxPerYear ? grant(ref.referrer_id, `friend:${friend.id}`) : false;
  audit(db, now, 'system', 'referral.convert', { referrer: ref.referrer_id, friend: friend.id, referrerGot });
  return { service, friendGot, referrerGot, why: referrerGot ? null : carried ? 'already-given' : 'yearly-cap' };
}

/* ---------- sales and visits ---------- */

/* input: { phone, regNo, tyre, size, qty, odometerKm, fittedOn?, billNo?, amountPaise?, warrantyMonths?,
            newTreadMm?, remindersOk?, referralCode?, confirm?, idem? }, all already validated.
   opts.backfill lets the demo seed give stamps for sales dated in the past. */
function registerSale(db, cfg, input, now, opts = {}) {
  const s = cfg.settings, today = todayFor(cfg, now);
  const fittedOn = input.fittedOn || today;
  return tx(db, () => {
    // the same form sent twice (a double tap, a retry on a bad connection) is one sale
    const again = input.idem ? db.q('SELECT * FROM sales WHERE idem = ?').get(input.idem) : null;
    if (again) return { saleId: again.id, customerId: again.customer_id, vehicleId: again.vehicle_id, token: again.token, duplicate: true, earned: [], referral: null, consent: consentOf(customerById(db, again.customer_id)) };

    let referrer = null;
    if (input.referralCode) {
      referrer = referrerByCode(db, input.referralCode);
      if (!referrer) throw new Problem('referralCode', 'No customer has this referral code. Check it or clear the box.');
      if (referrer.phone === input.phone) throw new Problem('referralCode', 'A customer cannot refer themselves.');
    }

    const customer = ensureCustomer(db, input.phone, now);
    db.q('INSERT OR IGNORE INTO vehicles (customer_id, reg_no, created_at) VALUES (?, ?, ?)').run(customer.id, input.regNo, now);
    const vehicle = db.q('SELECT * FROM vehicles WHERE customer_id = ? AND reg_no = ?').get(customer.id, input.regNo);

    const twin = db.q('SELECT * FROM sales WHERE vehicle_id = ? AND tyre = ? AND size = ? AND qty = ? AND fitted_on = ? AND created_at > ?')
      .get(vehicle.id, input.tyre, input.size, input.qty, fittedOn, now - 2 * 60e3);
    if (twin) return { saleId: twin.id, customerId: customer.id, vehicleId: vehicle.id, token: twin.token, duplicate: true, earned: [], referral: null, consent: consentOf(customer) };

    const firstSale = !db.q('SELECT 1 FROM sales WHERE customer_id = ? LIMIT 1').get(customer.id);
    if (referrer && !firstSale) throw new Problem('referralCode', 'Referral rewards are for a first purchase, and this customer has bought here before. Clear the box to save the sale.');
    // the invitation is noted before the sale is written, while this is still a number that has never bought
    if (referrer) linkReferral(db, cfg, customer.phone, referrer, now);

    const profile = est.profileFor(input.size, s.tyres);
    if (input.newTreadMm != null && input.newTreadMm <= profile.replaceAtMm + 1) throw new Problem('newTreadMm', `New tread depth must be more than ${profile.replaceAtMm + 1} mm.`);
    if (!input.confirm) {
      const before = db.q('SELECT MAX(odometer_km) AS km FROM visits WHERE vehicle_id = ? AND visited_on <= ?').get(vehicle.id, fittedOn).km;
      if (before != null && before > input.odometerKm) throw unusual('odometerKm', `The last reading for this vehicle was ${km(before)} km. Check the odometer, or save anyway if the meter was changed.`);
    }

    const months = input.warrantyMonths == null ? s.warranty.defaultMonths : input.warrantyMonths;
    const token = rand(16);
    const saleId = Number(db.q(`INSERT INTO sales (customer_id, vehicle_id, tyre, size, qty, odometer_km, new_tread_mm, bill_no, amount_paise, warranty_months, fitted_on, token, idem, created_at, entered_by)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(customer.id, vehicle.id, input.tyre, input.size, input.qty, input.odometerKm, input.newTreadMm, input.billNo, input.amountPaise, months, fittedOn, token, input.idem, now, opts.by || null).lastInsertRowid);

    const counts = !!opts.backfill || est.toDay(today) - est.toDay(fittedOn) <= 7;
    const st = stamp(db, cfg, customer.id, fittedOn, counts, now);
    db.q("INSERT INTO visits (customer_id, vehicle_id, sale_id, kind, visited_on, odometer_km, services, stamped, created_at, entered_by) VALUES (?, ?, ?, 'purchase', ?, ?, '[]', ?, ?, ?)")
      .run(customer.id, vehicle.id, saleId, fittedOn, input.odometerKm, st.stamped, now, opts.by || null);

    let consent = consentOf(customer);
    if (input.remindersOk === true && consent !== 'yes') consent = setReminders(db, cfg, customer, true, 'staff', now) === 'on' ? 'yes' : 'stopped';

    const referral = firstSale ? convertReferral(db, cfg, customer, input.regNo, now) : null;

    if (opts.onSaved) opts.onSaved(saleId);
    audit(db, now, opts.by || 'staff', 'sale.create', { sale: saleId, customer: customer.id });
    return { saleId, customerId: customer.id, vehicleId: vehicle.id, token, duplicate: false, earned: st.earned ? [st.earned] : [], referral, consent, profile: profile.key };
  });
}

/* input: { vehicleId, odometerKm?, treadMm?, services?, visitedOn?, confirm?, idem? }. A later visit: a reading,
   a service, or both. opts.backfill lets the demo seed write visits older than the staff page allows. */
function logVisit(db, cfg, input, now, opts = {}) {
  const s = cfg.settings, today = todayFor(cfg, now);
  const visitedOn = input.visitedOn || today;
  const services = input.services || [];
  if (input.odometerKm == null && input.treadMm == null && !services.length) throw new Problem('', 'Enter a reading or choose a service that was done.');
  return tx(db, () => {
    const again = input.idem ? db.q('SELECT * FROM visits WHERE idem = ?').get(input.idem) : null;
    if (again) return { visitId: again.id, customerId: again.customer_id, earned: [], duplicate: true };

    const vehicle = db.q('SELECT * FROM vehicles WHERE id = ?').get(input.vehicleId);
    if (!vehicle) throw new Problem('vehicleId', 'That vehicle was not found.');
    const sale = db.q('SELECT * FROM sales WHERE vehicle_id = ? AND fitted_on <= ? ORDER BY fitted_on DESC, id DESC LIMIT 1').get(vehicle.id, visitedOn);
    if (!sale) throw new Problem('visitedOn', 'The visit date is before the tyres were fitted.');
    const late = est.toDay(today) - est.toDay(visitedOn);
    if (!opts.backfill && late > 60) throw new Problem('visitedOn', 'A visit can be entered up to 60 days late.');

    const profile = est.profileFor(sale.size, s.tyres);
    const newTread = sale.new_tread_mm == null ? profile.newTreadMm : sale.new_tread_mm;
    if (input.odometerKm != null && input.odometerKm < sale.odometer_km) throw new Problem('odometerKm', `The odometer was ${km(sale.odometer_km)} km when these tyres were fitted. Check the reading.`);
    if (!input.confirm) {
      if (input.treadMm != null && input.treadMm > newTread + 1) throw unusual('treadMm', `These tyres are on record as starting at about ${newTread} mm. Check the gauge, or save anyway if it is right.`);
      // the last reading on or before this day, for a sanity check against a slip of the finger
      const prevOdo = db.q('SELECT odometer_km AS km, visited_on AS d FROM visits WHERE vehicle_id = ? AND visited_on <= ? AND odometer_km IS NOT NULL ORDER BY visited_on DESC, id DESC LIMIT 1').get(vehicle.id, visitedOn);
      if (input.odometerKm != null && prevOdo) {
        if (prevOdo.km > input.odometerKm) throw unusual('odometerKm', `The last reading for this vehicle was ${km(prevOdo.km)} km. Check the odometer, or save anyway if it is right.`);
        const days = Math.max(1, est.toDay(visitedOn) - est.toDay(prevOdo.d));
        if (input.odometerKm - prevOdo.km > 1500 * days) throw unusual('odometerKm', `That is ${km(input.odometerKm - prevOdo.km)} km since ${prevOdo.d}. Check the odometer, or save anyway if it is right.`);
      }
      const prevTread = db.q('SELECT tread_mm AS mm FROM visits WHERE sale_id = ? AND visited_on <= ? AND tread_mm IS NOT NULL ORDER BY visited_on DESC, id DESC LIMIT 1').get(sale.id, visitedOn);
      if (input.treadMm != null && prevTread && input.treadMm > prevTread.mm + 0.5) throw unusual('treadMm', `The last tread reading on these tyres was ${prevTread.mm} mm, and tread does not grow back. Check the gauge, or save anyway if it is right.`);
    }

    const st = stamp(db, cfg, vehicle.customer_id, visitedOn, !!opts.backfill || late <= 7, now);
    const visitId = Number(db.q("INSERT INTO visits (customer_id, vehicle_id, sale_id, kind, visited_on, odometer_km, tread_mm, services, stamped, idem, created_at) VALUES (?, ?, ?, 'service', ?, ?, ?, ?, ?, ?, ?)")
      .run(vehicle.customer_id, vehicle.id, sale.id, visitedOn, input.odometerKm, input.treadMm, JSON.stringify(services), st.stamped, input.idem, now).lastInsertRowid);
    if (opts.by) db.q('UPDATE visits SET entered_by = ? WHERE id = ?').run(opts.by, visitId);
    audit(db, now, opts.by || 'staff', 'visit.create', { visit: visitId, customer: vehicle.customer_id });
    return { visitId, customerId: vehicle.customer_id, earned: st.earned ? [st.earned] : [], duplicate: false };
  });
}

/* ---------- putting mistakes right ---------- */

/* A sale entered by mistake can be removed for a day, and everything it set in motion goes with it: its stamp,
   a yes to reminders ticked on it, any reminder marked against it, and what it did to a friend's invitation.
   Visits logged since are kept and handed back to the tyres that were on the vehicle before. Free services
   already earned on the visit card stay. */
function voidSale(db, saleId, now, by, hooks = {}) {
  const out = tx(db, () => {
    const sale = db.q('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) throw new Problem('sale', 'That sale was not found.');
    if (now - sale.created_at > DAY_MS) throw new Problem('sale', 'A sale can be removed for one day after it is entered.');
    if (hooks.before) hooks.before(sale);
    const customer = customerById(db, sale.customer_id);

    db.q("DELETE FROM visits WHERE sale_id = ? AND kind = 'purchase'").run(saleId);
    for (const v of db.q('SELECT id, visited_on FROM visits WHERE sale_id = ?').all(saleId)) {
      const prev = db.q('SELECT id FROM sales WHERE vehicle_id = ? AND id <> ? AND fitted_on <= ? ORDER BY fitted_on DESC, id DESC LIMIT 1').get(sale.vehicle_id, saleId, v.visited_on);
      db.q('UPDATE visits SET sale_id = ? WHERE id = ?').run(prev ? prev.id : null, v.id);
    }
    db.q('DELETE FROM sales WHERE id = ?').run(saleId);
    db.q('DELETE FROM reminder_log WHERE key LIKE ? OR key LIKE ?').run(`rep:${saleId}:%`, `svc:${saleId}:%`);
    if (!db.q('SELECT 1 FROM sales WHERE vehicle_id = ? LIMIT 1').get(sale.vehicle_id)) db.q('DELETE FROM vehicles WHERE id = ?').run(sale.vehicle_id);
    if (customer.reminders_ok && customer.consent_by === 'staff' && customer.consent_at === sale.created_at) {
      db.q('UPDATE customers SET reminders_ok = 0, consent_at = NULL, consent_by = NULL, consent_notice = NULL WHERE id = ?').run(customer.id);
    }

    /* If an invitation paid out on this sale (the sale, the invitation typed with it and its rewards all carry the
       same moment), that is undone too. Rewards not yet used are taken back. One the referrer has already used
       cannot be, so it is carried over to the corrected sale instead of being given a second time. The invitation
       itself is removed when it was typed in with this sale, and opened again when the friend made it. */
    const ref = db.q('SELECT * FROM referrals WHERE friend_phone = ?').get(customer.phone);
    if (ref && ref.converted_at === sale.created_at) {
      const tag = `friend:${customer.id}`;
      db.q("DELETE FROM grants WHERE customer_id = ? AND source = 'referral' AND ref = ? AND used_at IS NULL").run(ref.referrer_id, tag);
      db.q("UPDATE grants SET ref = 'friend:carry:' || id WHERE customer_id = ? AND source = 'referral' AND ref = ?").run(ref.referrer_id, tag);
      db.q("DELETE FROM grants WHERE customer_id = ? AND source = 'referral' AND ref = 'welcome' AND used_at IS NULL").run(customer.id);
      if (ref.created_at === sale.created_at) db.q('DELETE FROM referrals WHERE id = ?').run(ref.id);
      else db.q('UPDATE referrals SET converted_at = NULL WHERE id = ?').run(ref.id);
    }

    const left = !!db.q('SELECT 1 FROM sales WHERE customer_id = ? LIMIT 1').get(customer.id);
    if (!left) {
      // a wrong phone number typed for a brand new customer leaves nothing behind
      db.q('DELETE FROM customers WHERE id = ?').run(customer.id);
      db.q('DELETE FROM sessions WHERE phone = ?').run(customer.phone);
    }
    audit(db, now, by || 'staff', 'sale.void', { sale: saleId });
    return { customerId: left ? customer.id : null };
  });
  db.checkpoint();
  return out;
}

function renameVehicle(db, vehicleId, regNo, now, by) {
  const v = db.q('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  if (!v) throw new Problem('vehicle', 'That vehicle was not found.');
  if (db.q('SELECT 1 FROM vehicles WHERE customer_id = ? AND reg_no = ? AND id <> ?').get(v.customer_id, regNo, vehicleId)) throw new Problem('regNo', 'This customer already has a vehicle with that number.');
  db.q('UPDATE vehicles SET reg_no = ? WHERE id = ?').run(regNo, vehicleId);
  audit(db, now, by || 'staff', 'vehicle.rename', { vehicle: vehicleId });
  return v.customer_id;
}

/* ---------- what a customer (or staff looking at a customer) sees ---------- */

// the current set of tyres on a vehicle: estimate and services due
function planFor(sale, vehicleVisits, cfg, today) {
  const s = cfg.settings;
  const estimate = est.estimateSale(sale, vehicleVisits.filter(v => v.sale_id === sale.id), s.tyres, today);
  return { estimate, services: est.servicesDue(sale, vehicleVisits, s.reminders, estimate.profile, estimate.kmPerMonth, today) };
}

function saleView(sale, cfg, today, staff) {
  const until = est.addMonths(sale.fitted_on, sale.warranty_months);
  return {
    id: sale.id,
    tyre: sale.tyre,
    size: sale.size,
    qty: sale.qty,
    fittedOn: sale.fitted_on,
    odometerKm: sale.odometer_km > 0 ? sale.odometer_km : null,
    billNo: sale.bill_no,
    amountPaise: sale.amount_paise,
    warranty: sale.warranty_months ? { months: sale.warranty_months, until, active: until >= today, policyUrl: cfg.settings.warranty.policyUrl } : null,
    token: staff ? sale.token : undefined,
    enteredAt: staff ? sale.created_at : undefined,
  };
}

function passportFor(db, cfg, customer, now, { staff = false, base = '' } = {}) {
  const s = cfg.settings, today = todayFor(cfg, now), names = serviceNames(cfg);
  const vehicles = db.q('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id').all(customer.id).map(v => {
    const sales = db.q('SELECT * FROM sales WHERE vehicle_id = ? ORDER BY fitted_on DESC, id DESC').all(v.id);
    const visits = db.q('SELECT * FROM visits WHERE vehicle_id = ? ORDER BY visited_on DESC, id DESC').all(v.id).map(withServices);   // newest first, for the history
    const current = sales[0] || null;
    return {
      id: v.id,
      regNo: v.reg_no,
      current: current ? { ...saleView(current, cfg, today, staff), ...planFor(current, visits, cfg, today) } : null,
      earlier: sales.slice(1).map(x => saleView(x, cfg, today, staff)),
      history: visits.map(x => ({ on: x.visited_on, kind: x.kind, saleId: x.sale_id, odometerKm: x.odometer_km, treadMm: x.tread_mm, services: x.services.map(k => names.get(k) || k) })),
    };
  });
  // the newest fitting first: that is the vehicle the customer came in for
  vehicles.sort((a, b) => ((b.current && b.current.fittedOn) || '').localeCompare((a.current && a.current.fittedOn) || ''));

  const rule = s.rewards.referral;
  const out = {
    today,
    phoneLast4: customer.phone.slice(-4),
    reminders: { state: consentOf(customer), by: customer.consent_by, at: customer.reminders_ok ? customer.consent_at : customer.stopped_at },
    vehicles,
    card: cardView(db, cfg, customer.id),
    referral: rule.maxPerYear > 0
      ? { link: `${base}/passport/?ref=${customer.referral_code}`, code: customer.referral_code, service: names.get(rule.service), joined: db.q('SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND converted_at IS NOT NULL').get(customer.id).n }
      : null,
  };
  if (staff) Object.assign(out, { customerId: customer.id, phone: customer.phone, since: customer.created_at });
  return out;
}

// everything about one phone number, gone. Used by the customer's own delete and by staff on request.
function deleteCustomer(db, customer, actor, now) {
  tx(db, () => {
    db.q('DELETE FROM customers WHERE id = ?').run(customer.id);   // vehicles, sales, visits, rewards, referrals made, reminders and breakdowns go with it
    db.q('DELETE FROM referrals WHERE friend_phone = ?').run(customer.phone);
    db.q('DELETE FROM sessions WHERE phone = ?').run(customer.phone);
    db.q('DELETE FROM throttle WHERE key IN (?, ?)').run(`bd:gap:${customer.id}`, `bd:day:${customer.id}`);
    audit(db, now, actor, 'customer.delete', null);
  });
  db.checkpoint();
}

// q: digits of a phone number, or part of a vehicle number
function lookup(db, q) {
  const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
  const rows = /^\d{4,}$/.test(q)
    ? db.q("SELECT id FROM customers WHERE phone LIKE ? ESCAPE '\\' UNION SELECT customer_id FROM vehicles WHERE reg_no LIKE ? ESCAPE '\\' ORDER BY 1 DESC LIMIT 20").all(like, like)
    : db.q("SELECT DISTINCT customer_id AS id FROM vehicles WHERE reg_no LIKE ? ESCAPE '\\' ORDER BY 1 DESC LIMIT 20").all(like);
  return rows.map(r => {
    const c = customerById(db, r.id);
    return {
      customerId: c.id,
      phone: c.phone,
      vehicles: db.q('SELECT id, reg_no AS regNo FROM vehicles WHERE customer_id = ? ORDER BY id').all(c.id),
      lastVisitOn: db.q('SELECT MAX(visited_on) AS d FROM visits WHERE customer_id = ?').get(c.id).d,
    };
  });
}

module.exports = {
  Problem, rand, serviceNames, todayFor, customerByPhone, customerById, ensureCustomer, setReminders, consentOf,
  cardView, useGrant, unuseGrant, referrerByCode, linkReferral, convertReferral, registerSale, logVisit,
  voidSale, renameVehicle, planFor, passportFor, deleteCustomer, lookup,
};
