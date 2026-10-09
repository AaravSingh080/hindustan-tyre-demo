'use strict';

/* The staff list of who is due, worked out fresh from the readings each time it is opened.
   A reminder is only ever prepared here. A person at the shop sends it from WhatsApp, and the log records
   what that person did ("opened", "marked sent", "skipped"), never a delivery the server cannot know about. */

const est = require('./estimate');
const { planFor, consentOf } = require('./store');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDay = s => `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const nicePlate = r => r.replace(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/, (m, a, b, c, d) => [a, b, c, d].filter(Boolean).join(' '));
const nicePhone = p => p.replace(/^\+91(\d{5})(\d{5})$/, '$1 $2');
const list = words => (words.length < 2 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1]);

function replacementText(cfg, row, e, stopUrl) {
  const shop = cfg.settings.shop.name, plate = nicePlate(row.reg_no), call = nicePhone(cfg.settings.shops[0].phone);
  const why = e.reason === 'age'
    ? `will be ${cfg.settings.tyres.maxAgeYears} years old around ${niceDay(e.dueOn)}, the age at which tyres should be changed whatever the tread`
    : e.basis === 'readings'
      ? `should reach replacement depth around ${niceDay(e.dueOn)}, going by the tread readings we have taken`
      : `should be near replacement around ${niceDay(e.dueOn)}, going by typical tyre life for this kind of tyre`;
  return `${shop} here. The ${row.tyre} tyres we fitted on ${plate} on ${niceDay(row.fitted_on)} ${why}. Come in for a free tread check and we will tell you plainly how much life is left. Call ${call}. To stop these reminders, reply STOP or open ${stopUrl}`;
}

function serviceText(cfg, row, due, free, stopUrl) {
  const shop = cfg.settings.shop.name, plate = nicePlate(row.reg_no), call = nicePhone(cfg.settings.shops[0].phone);
  const what = list(due.map(d => d.name.toLowerCase()));
  const every = due[0];
  const gift = free.length ? ` Free on your visit card: ${list(free.map(n => n.toLowerCase()))}.` : '';
  return `${shop} here. ${plate} is due for service: ${what} (about every ${every.everyKm.toLocaleString('en-IN')} km or ${every.everyMonths} months, whichever comes first).${gift} Call ${call} or drop in. To stop these reminders, reply STOP or open ${stopUrl}`;
}

// base: the public address links are built on. Returns every reminder that is due, soonest first.
function dueItems(db, cfg, now, base) {
  const s = cfg.settings, today = est.today(now, s.shop.utcOffsetMinutes);
  // only the newest set of tyres on each vehicle is live
  const rows = db.q(`SELECT s.*, v.reg_no, c.phone, c.reminders_ok, c.stopped_at, c.stop_token
                     FROM sales s JOIN vehicles v ON v.id = s.vehicle_id JOIN customers c ON c.id = s.customer_id
                     WHERE s.id = (SELECT x.id FROM sales x WHERE x.vehicle_id = s.vehicle_id ORDER BY x.fitted_on DESC, x.id DESC LIMIT 1)`).all();
  const log = new Map(db.q('SELECT key, status, at FROM reminder_log').all().map(r => [r.key, r]));
  const items = [];

  for (const row of rows) {
    const visits = db.q('SELECT * FROM visits WHERE vehicle_id = ? ORDER BY visited_on, id').all(row.vehicle_id).map(v => ({ ...v, services: JSON.parse(v.services) }));
    const plan = planFor(row, visits, cfg, today), e = plan.estimate;
    const consent = consentOf(row);
    const stopUrl = `${base}/stop/${row.stop_token}`;
    const common = { customerId: row.customer_id, vehicleId: row.vehicle_id, saleId: row.id, phone: row.phone, regNo: row.reg_no, tyre: row.tyre, size: row.size, fittedOn: row.fitted_on, consent };
    const push = (key, extra, text, fresh) => {
      const done = fresh ? null : log.get(key);
      const item = { key, ...common, ...extra, status: done ? done.status : 'ready', statusAt: done ? done.at : null };
      // the message and the WhatsApp link exist only for customers who agreed
      if (consent === 'yes') { item.message = text; item.waUrl = `https://wa.me/${row.phone.slice(1)}?text=${encodeURIComponent(text)}`; }
      items.push(item);
    };

    if (e.daysLeft <= s.reminders.replacementLeadDays && e.daysLeft >= -365) {
      /* One note, about a month ahead, per estimate. If a note was logged and a later reading then moved the
         date well into the future, that note was about a different date, so the reminder is offered again when
         the new date comes round. */
      const key = `rep:${row.id}:1`, logged = log.get(key);
      const moved = !!logged && est.toDay(e.dueOn) - est.toDay(est.today(logged.at, s.shop.utcOffsetMinutes)) > 2 * s.reminders.replacementLeadDays;
      push(key, { type: 'replacement', dueOn: e.dueOn, daysLeft: e.daysLeft, basis: e.basis, reason: e.reason, readings: e.readings, atLimit: e.atLimit },
        replacementText(cfg, row, e, stopUrl), moved);
      continue;   // nobody needs a rotation reminder for tyres that are about to come off
    }

    // services that are due go out as one message, not one each. The key is the day the most overdue of them
    // was last done (or the fitting day), which changes only when that service is done again: so the message
    // is prepared once per round, however the estimated dates shift with new odometer readings.
    const due = plan.services.filter(v => v.daysLeft <= s.reminders.serviceLeadDays && v.daysLeft >= -180).sort((a, b) => a.daysLeft - b.daysLeft);
    if (!due.length) continue;
    const free = due.filter(d => db.q('SELECT 1 FROM grants WHERE customer_id = ? AND service = ? AND used_at IS NULL LIMIT 1').get(row.customer_id, d.key)).map(d => d.name);
    push(`svc:${row.id}:${due[0].lastDoneOn || row.fitted_on}`, { type: 'service', services: due.map(d => d.name), dueOn: due[0].dueOn, daysLeft: due[0].daysLeft, by: due[0].by, free },
      serviceText(cfg, row, due, free, stopUrl));
  }
  return items.sort((a, b) => a.daysLeft - b.daysLeft || a.key.localeCompare(b.key));
}

const KEY = /^(rep:\d{1,12}:1|svc:\d{1,12}:\d{4}-\d{2}-\d{2})$/;

// status: what the person at the shop did with it. Only a reminder that is due right now, for a customer who agreed.
function markReminder(db, cfg, key, status, now, base) {
  if (typeof key !== 'string' || !KEY.test(key)) return null;
  const item = dueItems(db, cfg, now, base).find(i => i.key === key);
  if (!item || item.consent !== 'yes') return null;
  db.q('INSERT INTO reminder_log (key, customer_id, status, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, at = excluded.at').run(key, item.customerId, status, now);
  return { ...item, status, statusAt: now };
}

module.exports = { dueItems, markReminder, niceDay, nicePlate, nicePhone };
