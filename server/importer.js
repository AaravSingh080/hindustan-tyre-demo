'use strict';

/* Bringing the old customer book in. The owner's browser reads the spreadsheet (saved as CSV), shows what it
   understood, and sends the rows here a few at a time. Each row is checked like a sale typed at the desk and
   registered as a sale on its own date; a row that is already in the book is reported as a duplicate, not
   added twice; a row that cannot be read is reported with the reason and the rest still go in. */

const { Invalid, is, shape, need, opt } = require('./validate');
const store = require('./store');
const { keyOf } = require('./stock');

const BATCH = 25;
const BACK_DAYS = 20 * 366;

function rowSpec(cfg, today) {
  const demo = cfg.mode === 'demo';
  return {
    phone: need(is.phone({ demo }), 'The mobile number is missing.'),
    regNo: need(is.regNo('regNo'), 'The vehicle number is missing.'),
    tyre: need(is.text('tyre', 2, 80, 'the tyre brand and model'), 'The tyre is missing.'),
    size: need(is.size('size'), 'The tyre size is missing.'),
    qty: need(is.int('qty', 1, 24, 'the number of tyres'), 'The number of tyres is missing.'),
    fittedOn: need(is.day('fittedOn', today, BACK_DAYS, 'the fitting date'), 'The fitting date is missing.'),
    odometerKm: opt(is.int('odometerKm', 0, 3000000, 'the odometer reading in km')),
    billNo: opt(is.billNo('billNo')),
    amount: opt(is.rupees('amount')),
    remindersOk: opt(is.bool('remindersOk')),
  };
}

// rows: up to BATCH plain objects from the page. Returns one result per row, in order.
function importRows(db, cfg, rows, actor, now) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > BATCH) throw new Invalid('rows', `Send between 1 and ${BATCH} rows at a time.`);
  const today = store.todayFor(cfg, now);
  const spec = rowSpec(cfg, today);
  const results = [];
  for (const raw of rows) {
    let row;
    try { row = shape(raw, spec); } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      results.push({ ok: false, field: e.field, error: e.message });
      continue;
    }
    // the same vehicle, size and date already in the book: the row was imported before, or the sale was typed at the desk
    const twin = db.q(`SELECT s.id, s.size FROM sales s JOIN vehicles v ON v.id = s.vehicle_id JOIN customers c ON c.id = s.customer_id
                       WHERE c.phone = ? AND v.reg_no = ? AND s.fitted_on = ?`).all(row.phone, row.regNo, row.fittedOn).find(t => keyOf(t.size) === keyOf(row.size));
    if (twin) { results.push({ ok: true, duplicate: true, saleId: twin.id }); continue; }
    try {
      const { amount, ...rest } = row;
      const done = store.registerSale(db, cfg, { ...rest, amountPaise: amount, odometerKm: row.odometerKm == null ? 0 : row.odometerKm, warrantyMonths: null, newTreadMm: null, referralCode: null, confirm: true, idem: null }, now, { backfill: true, by: actor });
      results.push({ ok: true, duplicate: !!done.duplicate, saleId: done.saleId, customerId: done.customerId });
    } catch (e) {
      if (e instanceof store.Problem || e instanceof Invalid) results.push({ ok: false, field: e.field, error: e.message });
      else throw e;
    }
  }
  return results;
}

module.exports = { importRows, rowSpec, BATCH, BACK_DAYS };
