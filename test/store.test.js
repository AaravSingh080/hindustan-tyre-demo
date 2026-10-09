'use strict';

/* Domain rules of the tyre passport, tested below the HTTP layer: server/store.js, server/reminders.js,
   server/db.js and server/seed.js.

   Almost every test builds its own empty in-memory database with the settings written out below and a fixed
   clock, so nothing here depends on today's date or on what the owner later changes in config/passport.json.
   The few tests about the demo samples start a real demo app; the ones about a live database use a fresh
   folder under the system temp folder (left in place afterwards: this file never deletes anything itself). */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../server/config');
const { openDb, getMeta, sweep, backup, DAY_MS } = require('../server/db');
const est = require('../server/estimate');
const store = require('../server/store');
const { dueItems, markReminder } = require('../server/reminders');
const { seedDemo, DEMO_SAMPLES } = require('../server/seed');
const { createApp } = require('../server/app');

/* ---------- fixed world ---------- */

const T0 = Date.UTC(2026, 9, 6, 6, 30);   // 6 October 2026, noon in India
const TODAY = '2026-10-06';
const MIN = 60e3, HOUR = 3600e3;
const BASE = 'https://passport.example';
// explicit, so the tests do not read this computer's environment or trip over a ./data folder
const DEMO_ENV = { PASSPORT_MODE: 'demo' };

const SETTINGS = {
  shop: { name: 'Hindustan Tyre Agencies', whatsapp: '918303400005', utcOffsetMinutes: 330 },
  shops: [{ id: 'ludhiana', name: 'Hindustan Tyre Agencies, Ludhiana', phone: '+918303400005', address: 'H-20, New Market, Ludhiana, Punjab', lat: 30.9122, lng: 75.8483 }],
  rewards: {
    services: [
      { key: 'pressure-tread-check', name: 'Pressure and tread check' },
      { key: 'rotation', name: 'Tyre rotation' },
      { key: 'alignment-check', name: 'Alignment check' },
      { key: 'puncture-repair', name: 'Puncture repair' },
    ],
    cardVisits: 8,
    card: [
      { atVisit: 2, service: 'pressure-tread-check' },
      { atVisit: 4, service: 'rotation' },
      { atVisit: 6, service: 'alignment-check' },
      { atVisit: 8, service: 'puncture-repair' },
    ],
    referral: { service: 'rotation', maxPerYear: 6 },
  },
  reminders: {
    replacementLeadDays: 30,
    serviceLeadDays: 7,
    services: [
      { key: 'rotation', name: 'Tyre rotation', everyKm: 5000, everyMonths: 6, for: ['car'] },
      { key: 'alignment-check', name: 'Alignment check', everyKm: 5000, everyMonths: 6, for: ['car'] },
    ],
  },
  tyres: {
    maxAgeYears: 6,
    minKmForReadings: 5000,
    profiles: [
      { key: 'two-wheeler', sizeMatch: '^[2-4]\\.\\d{2}-\\d{2}$|^\\d{2,3}/\\d{2,3}-\\d{2}$', newTreadMm: 5.0, replaceAtMm: 1.0, legalMinMm: 0.8, typicalLifeKm: 30000, typicalMonthlyKm: 800 },
      { key: 'truck', sizeMatch: '^([5-9]|1[0-4])\\.\\d{2}[-R]\\d{2}$|R(17\\.5|19\\.5|22\\.5|24\\.5)$', newTreadMm: 16.0, replaceAtMm: 2.0, legalMinMm: 1.6, typicalLifeKm: 80000, typicalMonthlyKm: 6000 },
      { key: 'car', sizeMatch: '', newTreadMm: 7.5, replaceAtMm: 2.0, legalMinMm: 1.6, typicalLifeKm: 45000, typicalMonthlyKm: 1000 },
    ],
  },
  warranty: { defaultMonths: 60, policyUrl: 'https://example.com/tyre-warranty' },
  privacy: { deleteAfterInactiveYears: 7, noticeVersion: 'test-1' },
};

const settings = edit => { const s = structuredClone(SETTINGS); if (edit) edit(s); return s; };
const configWith = edit => loadConfig(DEMO_ENV, { settings: settings(edit) });

const opened = [];
after(() => { for (const thing of opened) { try { thing.close(); } catch { /* already closed */ } } });

// an empty in-memory database with the settings above; `edit` changes the settings for one test
function world(edit) {
  const cfg = configWith(edit);
  const db = openDb(cfg, T0);
  opened.push(db);
  return { cfg, db };
}

function demoApp() {
  const app = createApp({ env: DEMO_ENV, jitter: false, now: () => T0 });
  opened.push(app);
  return app;
}

const fakeSms = { ready: true, sendOtp: async () => ({ ok: true }) };
// a live app on the database in `dir`; `env` changes its keys for one test (a new staff PIN, say)
function liveApp(dir, env) {
  const app = createApp({
    env: { APP_SECRET: 'x'.repeat(40), STAFF_PIN: '48151623', PUBLIC_BASE_URL: 'http://localhost:1', DATA_DIR: dir, MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't', ...env },
    settings: settings(),
    sms: fakeSms,
    jitter: false,
    now: () => T0,
  });
  opened.push(app);
  return app;
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hta-store-test-'));
// which of the live database's own files (the main file, its write-ahead log, its index) hold this text
const filesHolding = (dir, text) => fs.readdirSync(dir).filter(f => f.startsWith('passport.sqlite') && fs.readFileSync(path.join(dir, f)).includes(text));

/* ---------- small helpers ---------- */

const phone = n => '+91555' + String(n).padStart(7, '0');
const plate = n => 'PB00TS' + String(n).padStart(4, '0');
const ago = days => est.addDays(TODAY, -days);
const later = days => T0 + days * DAY_MS;
const backThen = days => T0 - days * DAY_MS;   // the moment, that many days ago, at which something was entered

// what the HTTP layer hands the store: every optional field present, null when it was left empty
const EMPTY_SALE = { fittedOn: null, billNo: null, amountPaise: null, warrantyMonths: null, newTreadMm: null, remindersOk: null, referralCode: null, confirm: null, idem: null };
const CAR = { tyre: 'MRF ZVTV', size: '185/65 R15', qty: 4, odometerKm: 20000 };
const sell = (w, input, now = T0, opts) => store.registerSale(w.db, w.cfg, { ...EMPTY_SALE, ...CAR, ...input }, now, opts);
const EMPTY_VISIT = { odometerKm: null, treadMm: null, services: null, visitedOn: null, confirm: null, idem: null };
const visit = (w, input, now = T0, opts) => store.logVisit(w.db, w.cfg, { ...EMPTY_VISIT, ...input }, now, opts);

const rows = (db, sql, ...args) => db.q(sql).all(...args).map(r => ({ ...r }));
const count = (db, table, where = '1 = 1', ...args) => db.q(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
const customer = (w, id) => store.customerById(w.db, id);
const card = (w, customerId) => store.cardView(w.db, w.cfg, customerId);
const referralGrants = (db, customerId) => rows(db, "SELECT service, used_at FROM grants WHERE customer_id = ? AND source = 'referral'", customerId);

const TABLES = ['customers', 'vehicles', 'sales', 'visits', 'grants', 'referrals', 'reminder_log', 'breakdowns', 'otp_codes', 'sessions', 'devices', 'throttle', 'audit', 'meta'];
const dump = db => JSON.stringify(Object.fromEntries(TABLES.map(t => [t, rows(db, `SELECT * FROM ${t}`)])));

let sessionSeq = 0;
const addSession = (db, forPhone, kind = 'customer', expiresAt = T0 + 30 * DAY_MS) =>
  db.q('INSERT INTO sessions (token_hash, kind, phone, tag, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('session-' + (++sessionSeq), kind, forPhone, kind === 'staff' ? 'pin-tag' : null, T0, T0, expiresAt);

// the call must be refused with a message for the person at the keyboard, about `field`
function refused(fn, field, { canConfirm = false, message } = {}) {
  assert.throws(fn, e => {
    assert.ok(e instanceof store.Problem, `expected a Problem the user can put right, got: ${e && e.stack}`);
    assert.equal(e.field, field);
    assert.equal(!!(e.extra && e.extra.canConfirm), canConfirm, 'whether "save anyway" is offered');
    if (message) assert.match(e.message, message);
    return true;
  });
}

/* A car on the settings above with no readings is estimated to need new tyres 1370 days after fitting
   (45,000 km at 1,000 km a month), and its rotation and alignment check fall due 152 days after fitting
   (5,000 km at 1,000 km a month). The reminder tests place fitting days around those two numbers. */
const REPLACE_AFTER = 1370, SERVICE_AFTER = 152;

/* ---------- registering a sale ---------- */

describe('registering a sale', () => {
  test('a first sale creates the customer, the vehicle, the sale and a purchase visit', () => {
    const w = world();
    const r = sell(w, { phone: phone(1), regNo: plate(1), billNo: 'HTA/101', amountPaise: 2140000 });

    assert.equal(r.duplicate, false);
    assert.equal(r.profile, 'car');
    assert.equal(r.consent, 'no');
    assert.equal(r.referral, null);
    assert.deepEqual(r.earned, []);

    const customers = rows(w.db, 'SELECT * FROM customers');
    assert.equal(customers.length, 1);
    assert.equal(customers[0].id, r.customerId);
    assert.equal(customers[0].phone, phone(1));
    assert.match(customers[0].referral_code, /^[A-Z0-9]{8}$/, 'a code the referral box on the forms will accept');

    assert.deepEqual(rows(w.db, 'SELECT id, customer_id, reg_no FROM vehicles'), [{ id: r.vehicleId, customer_id: r.customerId, reg_no: plate(1) }]);

    assert.deepEqual(
      rows(w.db, 'SELECT id, customer_id, vehicle_id, tyre, size, qty, odometer_km, bill_no, amount_paise, fitted_on, token, created_at FROM sales'),
      [{ id: r.saleId, customer_id: r.customerId, vehicle_id: r.vehicleId, tyre: 'MRF ZVTV', size: '185/65 R15', qty: 4, odometer_km: 20000, bill_no: 'HTA/101', amount_paise: 2140000, fitted_on: TODAY, token: r.token, created_at: T0 }],
    );

    assert.deepEqual(
      rows(w.db, 'SELECT customer_id, vehicle_id, sale_id, kind, visited_on, odometer_km, tread_mm, services, stamped FROM visits'),
      [{ customer_id: r.customerId, vehicle_id: r.vehicleId, sale_id: r.saleId, kind: 'purchase', visited_on: TODAY, odometer_km: 20000, tread_mm: null, services: '[]', stamped: 1 }],
    );
  });

  test('a returning phone number and a returning vehicle are recognised, not duplicated', () => {
    const w = world();
    const a = sell(w, { phone: phone(1), regNo: plate(1) });
    const b = sell(w, { phone: phone(1), regNo: plate(2) }, later(30));
    const c = sell(w, { phone: phone(1), regNo: plate(1), tyre: 'Apollo Alnac 4G', odometerKm: 61000 }, later(900));

    assert.equal(b.customerId, a.customerId);
    assert.notEqual(b.vehicleId, a.vehicleId);
    assert.equal(c.vehicleId, a.vehicleId);
    assert.deepEqual([count(w.db, 'customers'), count(w.db, 'vehicles'), count(w.db, 'sales'), count(w.db, 'visits')], [1, 2, 3, 3]);
    assert.equal(new Set([a.token, b.token, c.token]).size, 3, 'every sale has its own passport link');

    // the passport shows the newest tyres on a vehicle as current and the set before as earlier
    const view = store.passportFor(w.db, w.cfg, customer(w, a.customerId), later(900));
    const car = view.vehicles.find(v => v.regNo === plate(1));
    assert.equal(car.current.id, c.saleId);
    assert.deepEqual(car.earlier.map(x => x.id), [a.saleId]);
  });

  test("the day of a sale is the shop's day in India, not the UTC day", () => {
    const w = world();
    const halfPastMidnightIst = Date.UTC(2026, 9, 6, 19, 0);   // still 6 October in UTC
    const r = sell(w, { phone: phone(1), regNo: plate(1) }, halfPastMidnightIst);
    assert.equal(w.db.q('SELECT fitted_on FROM sales WHERE id = ?').get(r.saleId).fitted_on, '2026-10-07');
  });

  test('the same form sent twice with one request label is one sale', () => {
    const w = world();
    const first = sell(w, { phone: phone(1), regNo: plate(1), remindersOk: true, idem: 'sale-form-0001' });
    // a retry on a bad connection, well outside the double-tap window
    const retry = sell(w, { phone: phone(1), regNo: plate(1), remindersOk: true, idem: 'sale-form-0001' }, T0 + 20 * MIN);

    assert.equal(retry.duplicate, true);
    assert.equal(retry.saleId, first.saleId);
    assert.equal(retry.token, first.token);
    assert.equal(retry.consent, 'yes');
    assert.deepEqual(retry.earned, []);
    assert.deepEqual([count(w.db, 'customers'), count(w.db, 'vehicles'), count(w.db, 'sales'), count(w.db, 'visits')], [1, 1, 1, 1]);
  });

  test('a double tap without a label is caught for two minutes, without swallowing a different sale', () => {
    const w = world();
    const first = sell(w, { phone: phone(1), regNo: plate(1) });

    const tap = sell(w, { phone: phone(1), regNo: plate(1) }, T0 + 90e3);
    assert.equal(tap.duplicate, true);
    assert.equal(tap.saleId, first.saleId);
    const relabelled = sell(w, { phone: phone(1), regNo: plate(1), idem: 'another-label-1' }, T0 + 100e3);
    assert.equal(relabelled.duplicate, true, 'the same details under a new label are still the same sale');
    assert.equal(count(w.db, 'sales'), 1);

    // two more tyres for the same car a minute later is a real second sale
    const different = sell(w, { phone: phone(1), regNo: plate(1), qty: 2 }, T0 + 110e3);
    assert.equal(different.duplicate, false);
    // and so is the same line entered again once the two minutes are over
    const muchLater = sell(w, { phone: phone(1), regNo: plate(1) }, T0 + 3 * MIN);
    assert.equal(muchLater.duplicate, false);
    assert.equal(count(w.db, 'sales'), 3);
  });

  test("an odometer below the vehicle's last reading is refused once and saved when confirmed", () => {
    const w = world();
    sell(w, { phone: phone(1), regNo: plate(1), odometerKm: 52000, fittedOn: ago(400) });

    const next = { phone: phone(1), regNo: plate(1), tyre: 'Apollo Alnac 4G', odometerKm: 48000 };
    refused(() => sell(w, next), 'odometerKm', { canConfirm: true, message: /52,000 km/ });
    assert.deepEqual([count(w.db, 'sales'), count(w.db, 'visits')], [1, 1], 'the refused sale saved nothing');

    const saved = sell(w, { ...next, confirm: true });
    assert.equal(saved.duplicate, false);
    assert.equal(w.db.q('SELECT odometer_km FROM sales WHERE id = ?').get(saved.saleId).odometer_km, 48000);
  });

  test('consent to reminders is recorded only when the box was ticked', () => {
    const w = world();
    const unticked = sell(w, { phone: phone(1), regNo: plate(1), remindersOk: false });
    const leftEmpty = sell(w, { phone: phone(2), regNo: plate(2) });
    const ticked = sell(w, { phone: phone(3), regNo: plate(3), remindersOk: true });

    assert.deepEqual([unticked.consent, leftEmpty.consent, ticked.consent], ['no', 'no', 'yes']);
    const consent = id => ({ ...w.db.q('SELECT reminders_ok, consent_at, consent_by, consent_notice, stopped_at FROM customers WHERE id = ?').get(id) });
    const nothing = { reminders_ok: 0, consent_at: null, consent_by: null, consent_notice: null, stopped_at: null };
    assert.deepEqual(consent(unticked.customerId), nothing);
    assert.deepEqual(consent(leftEmpty.customerId), nothing);
    assert.deepEqual(consent(ticked.customerId), { reminders_ok: 1, consent_at: T0, consent_by: 'staff', consent_notice: 'test-1', stopped_at: null });

    // a later sale with the box left empty neither withdraws the yes nor re-dates it
    const again = sell(w, { phone: phone(3), regNo: plate(4), remindersOk: false }, later(1));
    assert.equal(again.consent, 'yes');
    assert.equal(consent(ticked.customerId).consent_at, T0);
  });

  test('warranty falls back to the configured default and can be set, or switched off, per sale', () => {
    const w = world();
    const byDefault = sell(w, { phone: phone(1), regNo: plate(1) });
    const twoYears = sell(w, { phone: phone(2), regNo: plate(2), warrantyMonths: 24 });
    const none = sell(w, { phone: phone(3), regNo: plate(3), warrantyMonths: 0 });

    const months = id => w.db.q('SELECT warranty_months AS m FROM sales WHERE id = ?').get(id).m;
    assert.deepEqual([months(byDefault.saleId), months(twoYears.saleId), months(none.saleId)], [60, 24, 0]);

    const shown = r => store.passportFor(w.db, w.cfg, customer(w, r.customerId), T0).vehicles[0].current.warranty;
    assert.deepEqual(shown(byDefault), { months: 60, until: '2031-10-06', active: true, policyUrl: 'https://example.com/tyre-warranty' });
    assert.equal(shown(twoYears).until, '2028-10-06');
    assert.equal(shown(none), null, 'no warranty is shown for 0 months');
  });

  test('a refused sale leaves nothing behind, not even the new customer', () => {
    const w = world();
    // a "new" tread depth that is already at replacement depth is a typing slip
    refused(() => sell(w, { phone: phone(1), regNo: plate(1), newTreadMm: 3 }), 'newTreadMm');
    refused(() => sell(w, { phone: phone(1), regNo: plate(1), referralCode: 'ZZZZ9999' }), 'referralCode', { message: /No customer has this referral code/ });
    for (const table of ['customers', 'vehicles', 'sales', 'visits', 'referrals', 'grants']) assert.equal(count(w.db, table), 0, table);
  });

  test("the customer's own view carries neither the full phone number nor the passport link token", () => {
    const w = world();
    const r = sell(w, { phone: phone(1), regNo: plate(1) });
    const me = customer(w, r.customerId);

    const mine = JSON.stringify(store.passportFor(w.db, w.cfg, me, T0, { base: BASE }));
    assert.ok(!mine.includes(phone(1).slice(3)), 'full phone number in the customer view');
    assert.ok(!mine.includes(r.token), 'sale token in the customer view');
    assert.equal(JSON.parse(mine).phoneLast4, '0001');

    const staff = store.passportFor(w.db, w.cfg, me, T0, { staff: true, base: BASE });
    assert.equal(staff.phone, phone(1));
    assert.equal(staff.vehicles[0].current.token, r.token);
  });

  test('a size typed with its ply rating or load index is still the right kind of tyre', () => {
    const w = world();
    const truck = sell(w, { phone: phone(1), regNo: plate(1), tyre: 'Apollo XT-7', size: '10.00-20 16PR', qty: 6, odometerKm: 100000, fittedOn: ago(100) });
    const scooter = sell(w, { phone: phone(2), regNo: plate(2), tyre: 'CEAT Milaze', size: '90/100-10 53J', qty: 2 });
    const car = sell(w, { phone: phone(3), regNo: plate(3), size: '185/65 R15 88H' });
    assert.deepEqual([truck.profile, scooter.profile, car.profile], ['truck', 'two-wheeler', 'car']);

    // so an ordinary reading on the truck tyre (16 mm when new) is not questioned as deeper than a new car tyre
    const reading = visit(w, { vehicleId: truck.vehicleId, odometerKm: 118000, treadMm: 14.2 });
    assert.equal(reading.duplicate, false);
    const shown = r => store.passportFor(w.db, w.cfg, customer(w, r.customerId), T0).vehicles[0].current.estimate;
    assert.deepEqual([shown(truck).profile, shown(truck).newTreadMm, shown(truck).lastReadingMm], ['truck', 16, 14.2]);
    assert.deepEqual([shown(scooter).profile, shown(scooter).legalMinMm], ['two-wheeler', 0.8]);
  });
});

/* ---------- logging a visit ---------- */

describe('logging a visit', () => {
  // a car fitted 100 days ago at 20,000 km
  const fitted = () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), odometerKm: 20000, fittedOn: ago(100) });
    return { w, s, vehicleId: s.vehicleId };
  };

  test('a visit needs a reading or a service', () => {
    const { w, s, vehicleId } = fitted();
    refused(() => visit(w, { vehicleId }), '', { message: /reading|service/ });
    refused(() => visit(w, { vehicleId, services: [] }), '');
    assert.equal(count(w.db, 'visits'), 1);

    const serviceOnly = visit(w, { vehicleId, services: ['rotation', 'alignment-check'] });
    const treadOnly = visit(w, { vehicleId, treadMm: 6.1 });
    const odometerOnly = visit(w, { vehicleId, odometerKm: 23000 });
    for (const done of [serviceOnly, treadOnly, odometerOnly]) {
      assert.equal(done.duplicate, false);
      assert.equal(done.customerId, s.customerId);
    }
    assert.deepEqual(
      rows(w.db, "SELECT id, sale_id, visited_on, odometer_km, tread_mm, services FROM visits WHERE kind = 'service' ORDER BY id"),
      [
        { id: serviceOnly.visitId, sale_id: s.saleId, visited_on: TODAY, odometer_km: null, tread_mm: null, services: '["rotation","alignment-check"]' },
        { id: treadOnly.visitId, sale_id: s.saleId, visited_on: TODAY, odometer_km: null, tread_mm: 6.1, services: '[]' },
        { id: odometerOnly.visitId, sale_id: s.saleId, visited_on: TODAY, odometer_km: 23000, tread_mm: null, services: '[]' },
      ],
    );
  });

  test('an odometer reading below the reading at fitting is refused, with no way to save it anyway', () => {
    const { w, vehicleId } = fitted();
    refused(() => visit(w, { vehicleId, odometerKm: 19999 }), 'odometerKm', { canConfirm: false, message: /20,000 km/ });
    refused(() => visit(w, { vehicleId, odometerKm: 19999, confirm: true }), 'odometerKm', { canConfirm: false });
    assert.equal(count(w.db, 'visits'), 1);
  });

  test('a tread reading more than 1 mm deeper than the tyres started with is unusual: refused once, saved when confirmed', () => {
    const { w, vehicleId } = fitted();   // a car tyre: 7.5 mm when new
    refused(() => visit(w, { vehicleId, treadMm: 8.6 }), 'treadMm', { canConfirm: true, message: /starting at about 7\.5 mm/ });
    refused(() => visit(w, { vehicleId, treadMm: 8.6, confirm: false }), 'treadMm', { canConfirm: true });
    assert.equal(count(w.db, 'visits'), 1, 'the refused reading was not saved');

    const forced = visit(w, { vehicleId, treadMm: 8.6, confirm: true });
    assert.equal(forced.duplicate, false);
    assert.deepEqual(rows(w.db, "SELECT tread_mm FROM visits WHERE kind = 'service'"), [{ tread_mm: 8.6 }]);

    // exactly 1 mm over is still within what a gauge and a new tyre can differ by: saved without a question
    const other = sell(w, { phone: phone(2), regNo: plate(2), fittedOn: ago(100) });
    assert.equal(visit(w, { vehicleId: other.vehicleId, treadMm: 8.5 }).duplicate, false);

    // when the depth was measured at fitting, that is the depth the reading is held against
    const deep = sell(w, { phone: phone(3), regNo: plate(3), newTreadMm: 9, fittedOn: ago(100) });
    refused(() => visit(w, { vehicleId: deep.vehicleId, treadMm: 10.1 }), 'treadMm', { canConfirm: true, message: /starting at about 9 mm/ });
    assert.equal(visit(w, { vehicleId: deep.vehicleId, treadMm: 10 }).duplicate, false);
    assert.equal(count(w.db, 'visits', "kind = 'service'"), 3);
  });

  test('unusual readings are refused once and saved only when confirmed', () => {
    const { w, vehicleId } = fitted();
    visit(w, { vehicleId, odometerKm: 24000, treadMm: 6.0, visitedOn: ago(40) });
    const saved = () => count(w.db, 'visits');
    assert.equal(saved(), 2);

    // lower than the last reading (but above the fitting reading)
    refused(() => visit(w, { vehicleId, odometerKm: 23000 }), 'odometerKm', { canConfirm: true, message: /24,000 km/ });
    // more distance than anyone drives: 66,000 km in 40 days
    refused(() => visit(w, { vehicleId, odometerKm: 90000 }), 'odometerKm', { canConfirm: true, message: /66,000 km/ });
    // tread does not grow back
    refused(() => visit(w, { vehicleId, treadMm: 6.6 }), 'treadMm', { canConfirm: true, message: /6 mm/ });
    assert.equal(saved(), 2, 'none of the refused readings were saved');

    // ordinary readings pass without a question
    assert.equal(visit(w, { vehicleId, odometerKm: 26000, treadMm: 5.8 }).duplicate, false);
    // and an odd one is saved when the person says it is right
    const forced = visit(w, { vehicleId, odometerKm: 25000, confirm: true }, later(1));
    assert.equal(w.db.q('SELECT odometer_km FROM visits WHERE id = ?').get(forced.visitId).odometer_km, 25000);
    assert.equal(saved(), 4);
  });

  test('a visit can be entered up to 60 days late, never before the tyres were fitted, and only for a known vehicle', () => {
    const { w, vehicleId } = fitted();
    refused(() => visit(w, { vehicleId, services: ['rotation'], visitedOn: ago(61) }), 'visitedOn', { message: /60 days/ });
    refused(() => visit(w, { vehicleId, services: ['rotation'], visitedOn: ago(101) }), 'visitedOn', { message: /before the tyres were fitted/ });
    refused(() => visit(w, { vehicleId: 9999, services: ['rotation'] }), 'vehicleId');
    assert.equal(count(w.db, 'visits'), 1);

    const lateButAllowed = visit(w, { vehicleId, services: ['rotation'], visitedOn: ago(60) });
    assert.equal(w.db.q('SELECT visited_on FROM visits WHERE id = ?').get(lateButAllowed.visitId).visited_on, ago(60));
  });

  test('the same visit sent twice with one request label is saved once', () => {
    const { w, vehicleId } = fitted();
    const first = visit(w, { vehicleId, odometerKm: 23000, services: ['rotation'], idem: 'visit-form-0001' });
    const retry = visit(w, { vehicleId, odometerKm: 23000, services: ['rotation'], idem: 'visit-form-0001' }, T0 + 20 * MIN);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.visitId, first.visitId);
    assert.deepEqual(retry.earned, []);
    assert.equal(count(w.db, 'visits'), 2);
  });

  test('a reading entered again later the same day is the one the passport and the due list both go by', () => {
    const w = world();
    const view = (s, now) => store.passportFor(w.db, w.cfg, customer(w, s.customerId), now).vehicles[0].current.estimate;
    const onList = (s, now) => dueItems(w.db, w.cfg, now, BASE).find(i => i.saleId === s.saleId && i.type === 'replacement');

    // the gauge was misread as 6.2 mm; the right figure, 2.2 mm, is entered a minute later
    const worn = sell(w, { phone: phone(1), regNo: plate(1), odometerKm: 20000, fittedOn: ago(300), remindersOk: true });
    visit(w, { vehicleId: worn.vehicleId, odometerKm: 30000, treadMm: 6.2 });
    visit(w, { vehicleId: worn.vehicleId, odometerKm: 30000, treadMm: 2.2 }, T0 + MIN);
    const mine = view(worn, T0 + MIN);
    assert.deepEqual([mine.basis, mine.lastReadingMm, mine.daysLeft], ['readings', 2.2, 20]);
    const due = onList(worn, T0 + MIN);
    assert.deepEqual([due.dueOn, due.daysLeft], [mine.dueOn, 20], 'the staff list and the customer see the same date');

    // and the other way round: 2.2 mm was the slip, 6.2 mm is entered again and confirmed
    const sound = sell(w, { phone: phone(2), regNo: plate(2), odometerKm: 20000, fittedOn: ago(300), remindersOk: true });
    visit(w, { vehicleId: sound.vehicleId, odometerKm: 30000, treadMm: 2.2 });
    visit(w, { vehicleId: sound.vehicleId, odometerKm: 30000, treadMm: 6.2, confirm: true }, T0 + MIN);
    assert.equal(view(sound, T0 + MIN).lastReadingMm, 6.2);
    assert.ok(view(sound, T0 + MIN).daysLeft > 365, 'tyres with 6.2 mm left are not about to be replaced');
    assert.equal(onList(sound, T0 + MIN), undefined);
  });
});

/* ---------- the visit card ---------- */

describe('visit card', () => {
  const check = (w, vehicleId, now) => visit(w, { vehicleId, services: ['pressure-tread-check'] }, now);

  test('a customer gets one stamp a day, however many entries are made that day', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1) });                    // stamp 1
    check(w, s.vehicleId, T0 + HOUR);                                           // same day
    sell(w, { phone: phone(1), regNo: plate(2) }, T0 + 2 * HOUR);               // a second vehicle, same day
    assert.equal(card(w, s.customerId).stamps, 1);

    const nextDay = check(w, s.vehicleId, later(1));
    assert.deepEqual(nextDay.earned, ['Pressure and tread check']);
    const nextDayAgain = check(w, s.vehicleId, later(1) + HOUR);
    assert.deepEqual(nextDayAgain.earned, []);
    assert.equal(card(w, s.customerId).stamps, 2);
    assert.equal(count(w.db, 'grants'), 1);
  });

  test('only visits entered within a week of happening put a stamp on the card', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), fittedOn: ago(30) });   // an old bill typed in today
    assert.equal(card(w, s.customerId).stamps, 0);
    visit(w, { vehicleId: s.vehicleId, services: ['rotation'], visitedOn: ago(8) });
    assert.equal(card(w, s.customerId).stamps, 0);
    visit(w, { vehicleId: s.vehicleId, services: ['rotation'], visitedOn: ago(7) });
    assert.equal(card(w, s.customerId).stamps, 1);

    const eightDaysLate = sell(w, { phone: phone(2), regNo: plate(2), fittedOn: ago(8) });
    const sevenDaysLate = sell(w, { phone: phone(3), regNo: plate(3), fittedOn: ago(7) });
    assert.equal(card(w, eightDaysLate.customerId).stamps, 0);
    assert.equal(card(w, sevenDaysLate.customerId).stamps, 1);
  });

  test('free services are earned at the configured visits, and the card starts again after the last one', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1) });
    const earned = [s.earned], cards = [card(w, s.customerId)];
    for (let day = 1; day <= 9; day++) {
      earned.push(check(w, s.vehicleId, later(day)).earned);
      cards.push(card(w, s.customerId));
    }

    assert.deepEqual(earned, [
      [], ['Pressure and tread check'], [], ['Tyre rotation'], [], ['Alignment check'], [], ['Puncture repair'],
      [], ['Pressure and tread check'],   // visits 9 and 10: a new card
    ]);

    const eighth = cards[7], ninth = cards[8], tenth = cards[9];
    assert.deepEqual([eighth.stamps, eighth.place, eighth.cardVisits], [8, 8, 8]);
    assert.ok(eighth.steps.every(step => step.reached), 'a full card shows every step reached');
    assert.deepEqual([ninth.stamps, ninth.place], [9, 1]);
    assert.ok(ninth.steps.every(step => !step.reached), 'a new card starts with nothing reached');
    assert.equal(ninth.available.length, 4, 'what the first card earned is still there to use');
    assert.deepEqual(tenth.steps.map(step => [step.atVisit, step.reached]), [[2, true], [4, false], [6, false], [8, false]]);
    assert.equal(tenth.available.length, 5);
    assert.ok(tenth.available.every(g => g.source === 'card' && g.usedAt === null));
  });

  test('editing the card in the settings never hands out rewards for visits already stamped', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1) });
    check(w, s.vehicleId, later(1));
    check(w, s.vehicleId, later(2));
    assert.deepEqual(card(w, s.customerId).available.map(g => g.name), ['Pressure and tread check']);

    // the owner now puts rewards on visits 1 and 3 as well, and changes what visit 2 gives
    const edited = { db: w.db, cfg: configWith(x => {
      x.rewards.card = [
        { atVisit: 1, service: 'puncture-repair' },
        { atVisit: 2, service: 'rotation' },
        { atVisit: 3, service: 'alignment-check' },
        { atVisit: 4, service: 'rotation' },
      ];
    }) };

    // looking at the card, or another entry on a day already stamped, earns nothing
    assert.deepEqual(card(edited, s.customerId).available.map(g => g.name), ['Pressure and tread check']);
    assert.deepEqual(check(edited, s.vehicleId, later(2) + HOUR).earned, []);
    assert.equal(count(w.db, 'grants'), 1);

    // the next visit earns its own step and nothing for the steps that were added behind it
    assert.deepEqual(check(edited, s.vehicleId, later(3)).earned, ['Tyre rotation']);
    assert.deepEqual(rows(w.db, 'SELECT service FROM grants ORDER BY id'), [{ service: 'pressure-tread-check' }, { service: 'rotation' }]);
  });

  test('a free service can be marked used exactly once', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1) });
    check(w, s.vehicleId, later(1));
    const grant = card(w, s.customerId).available[0];
    const usedAt = later(1) + HOUR;

    assert.equal(store.useGrant(w.db, grant.id, usedAt), s.customerId);
    const view = card(w, s.customerId);
    assert.deepEqual(view.available, []);
    assert.deepEqual(view.used.map(g => [g.id, g.name, g.usedAt]), [[grant.id, 'Pressure and tread check', usedAt]]);

    refused(() => store.useGrant(w.db, grant.id, usedAt + MIN), 'grant', { message: /already been used/ });
    refused(() => store.useGrant(w.db, 987654, usedAt), 'grant', { message: /not found/ });
    assert.equal(w.db.q('SELECT used_at FROM grants WHERE id = ?').get(grant.id).used_at, usedAt, 'the second tap did not move the time it was used');
  });

  test('marking a free service used can be undone for ten minutes and no longer', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1) });
    check(w, s.vehicleId, later(1));
    const grant = card(w, s.customerId).available[0];
    const usedAt = later(1) + HOUR;

    refused(() => store.unuseGrant(w.db, grant.id, usedAt), 'grant');   // nothing to undo yet
    store.useGrant(w.db, grant.id, usedAt);

    refused(() => store.unuseGrant(w.db, grant.id, usedAt + 10 * MIN + 1), 'grant', { message: /ten minutes/ });
    assert.equal(card(w, s.customerId).available.length, 0);

    assert.equal(store.unuseGrant(w.db, grant.id, usedAt + 10 * MIN), s.customerId);
    assert.deepEqual(card(w, s.customerId).available.map(g => g.id), [grant.id]);
    refused(() => store.unuseGrant(w.db, 987654, usedAt), 'grant', { message: /not found/ });

    // back on the card, it can be used again later
    store.useGrant(w.db, grant.id, later(5));
    assert.equal(card(w, s.customerId).used[0].usedAt, later(5));
  });
});

/* ---------- refer a friend ---------- */

describe('refer a friend', () => {
  const ROTATION = [{ service: 'rotation', used_at: null }];
  // an existing customer who can invite others
  const referrer = (w, n = 1) => customer(w, sell(w, { phone: phone(n), regNo: plate(n) }).customerId);

  test('an invitation earns nothing until the friend buys, and then both get the free service once', () => {
    const w = world();
    const a = referrer(w);
    assert.equal(store.linkReferral(w.db, w.cfg, phone(2), a, T0), 'linked');
    assert.equal(count(w.db, 'grants'), 0);
    assert.equal(store.passportFor(w.db, w.cfg, a, T0, { base: BASE }).referral.joined, 0);

    const first = sell(w, { phone: phone(2), regNo: plate(2) }, later(3));
    assert.deepEqual(first.referral, { service: 'Tyre rotation', friendGot: true, referrerGot: true, why: null });
    assert.deepEqual(referralGrants(w.db, a.id), ROTATION);
    assert.deepEqual(referralGrants(w.db, first.customerId), ROTATION);
    assert.deepEqual(card(w, a.id).available.map(g => [g.name, g.source]), [['Tyre rotation', 'referral']]);
    assert.deepEqual(store.passportFor(w.db, w.cfg, a, later(3), { base: BASE }).referral,
      { link: `${BASE}/passport/?ref=${a.referral_code}`, code: a.referral_code, service: 'Tyre rotation', joined: 1 });

    // the friend's next purchase is not a first purchase
    const second = sell(w, { phone: phone(2), regNo: plate(3) }, later(10));
    assert.equal(second.referral, null);
    assert.equal(count(w.db, 'grants', "source = 'referral'"), 2);
  });

  test("a referral code typed at the counter rewards both on the friend's first purchase", () => {
    const w = world();
    const a = referrer(w);
    const form = { phone: phone(2), regNo: plate(2), referralCode: a.referral_code, idem: 'friend-form-001' };
    const friend = sell(w, form, later(1));
    assert.deepEqual(friend.referral, { service: 'Tyre rotation', friendGot: true, referrerGot: true, why: null });
    assert.deepEqual(referralGrants(w.db, a.id), ROTATION);
    assert.deepEqual(referralGrants(w.db, friend.customerId), ROTATION);

    // the same form arriving a second time does not double the reward
    assert.equal(sell(w, form, later(1) + 30e3).duplicate, true);
    assert.equal(count(w.db, 'grants', "source = 'referral'"), 2);
  });

  test("a double tap on a referred friend's first sale is recognised as the same sale, not refused", () => {
    const w = world();
    const a = referrer(w);
    const form = { phone: phone(2), regNo: plate(2), referralCode: a.referral_code };
    const first = sell(w, form, later(1));
    const tap = sell(w, form, later(1) + 30e3);
    assert.equal(tap.duplicate, true);
    assert.equal(tap.saleId, first.saleId);
    assert.equal(tap.referral, null, 'the reward is reported once, with the sale that earned it');
    assert.equal(count(w.db, 'grants', "source = 'referral'"), 2);
    assert.equal(count(w.db, 'sales', 'customer_id = ?', first.customerId), 1);

    // once the two minutes are over, the same line is a second purchase, and that is still refused with the box filled in
    refused(() => sell(w, form, later(1) + 2 * MIN), 'referralCode', { message: /first purchase/ });
    assert.equal(count(w.db, 'sales', 'customer_id = ?', first.customerId), 1);
    assert.equal(count(w.db, 'grants', "source = 'referral'"), 2);
  });

  test('a customer cannot refer themselves', () => {
    const w = world();
    const a = referrer(w);
    assert.equal(store.linkReferral(w.db, w.cfg, a.phone, a, T0), 'self');
    refused(() => sell(w, { phone: a.phone, regNo: plate(5), referralCode: a.referral_code }, later(1)), 'referralCode', { message: /themselves/ });
    assert.deepEqual([count(w.db, 'referrals'), count(w.db, 'grants'), count(w.db, 'sales')], [0, 0, 1]);
  });

  test('someone who has already bought here cannot be referred', () => {
    const w = world();
    const a = referrer(w, 1);
    const b = referrer(w, 2);
    assert.equal(store.linkReferral(w.db, w.cfg, b.phone, a, later(1)), 'not-new');
    refused(() => sell(w, { phone: b.phone, regNo: plate(3), referralCode: a.referral_code }, later(1)), 'referralCode', { message: /first purchase/ });
    assert.deepEqual([count(w.db, 'referrals'), count(w.db, 'grants'), count(w.db, 'sales')], [0, 0, 2]);

    // with the box cleared the sale itself goes through, and earns nobody a referral reward
    const plain = sell(w, { phone: b.phone, regNo: plate(3) }, later(1));
    assert.equal(plain.referral, null);
    assert.equal(count(w.db, 'grants', "source = 'referral'"), 0);
  });

  test('the first invitation wins', () => {
    const w = world();
    const a = referrer(w, 1), b = referrer(w, 2);
    assert.equal(store.linkReferral(w.db, w.cfg, phone(3), a, T0), 'linked');
    assert.equal(store.linkReferral(w.db, w.cfg, phone(3), b, T0 + HOUR), 'exists');

    // even if the second inviter's code is the one typed at the counter
    const friend = sell(w, { phone: phone(3), regNo: plate(3), referralCode: b.referral_code }, later(1));
    assert.equal(friend.referral.friendGot, true);
    assert.deepEqual(referralGrants(w.db, a.id), ROTATION);
    assert.deepEqual(referralGrants(w.db, b.id), []);
  });

  test('a second phone number for a vehicle the shop already knows earns nothing for anyone', () => {
    const w = world();
    const a = referrer(w);   // owns plate(1)
    assert.equal(store.linkReferral(w.db, w.cfg, phone(2), a, T0), 'linked');

    const secondSim = sell(w, { phone: phone(2), regNo: plate(1), odometerKm: 20500 }, later(2));
    assert.deepEqual(secondSim.referral, { service: 'Tyre rotation', friendGot: false, referrerGot: false, why: 'vehicle-known' });
    assert.equal(secondSim.duplicate, false, 'the sale itself is saved');
    assert.deepEqual([count(w.db, 'sales'), count(w.db, 'grants'), count(w.db, 'referrals')], [2, 0, 0]);

    // and it cannot be tried again with another vehicle: that would no longer be a first purchase
    const again = sell(w, { phone: phone(2), regNo: plate(7) }, later(3));
    assert.equal(again.referral, null);
    assert.equal(count(w.db, 'grants', "source = 'referral'"), 0);
  });

  test('the yearly cap limits the referrer, never the friend', () => {
    const w = world(s => { s.rewards.referral.maxPerYear = 2; });
    const a = referrer(w);
    const friend = (n, now) => sell(w, { phone: phone(n), regNo: plate(n), referralCode: a.referral_code }, now);

    const one = friend(2, later(1)), two = friend(3, later(2)), three = friend(4, later(3));
    assert.deepEqual([one.referral.referrerGot, two.referral.referrerGot], [true, true]);
    assert.deepEqual(three.referral, { service: 'Tyre rotation', friendGot: true, referrerGot: false, why: 'yearly-cap' });
    assert.equal(referralGrants(w.db, a.id).length, 2);
    for (const f of [one, two, three]) assert.deepEqual(referralGrants(w.db, f.customerId), ROTATION);

    // a year on, the referrer can earn again
    const nextYear = friend(5, later(370));
    assert.deepEqual(nextYear.referral, { service: 'Tyre rotation', friendGot: true, referrerGot: true, why: null });
    assert.equal(referralGrants(w.db, a.id).length, 3);
  });

  test('with referrals switched off nothing is linked, nothing is earned and no link is shown', () => {
    const w = world(s => { s.rewards.referral.maxPerYear = 0; });
    const a = referrer(w);
    assert.equal(store.linkReferral(w.db, w.cfg, phone(2), a, T0), 'off');
    assert.equal(store.passportFor(w.db, w.cfg, a, T0, { base: BASE }).referral, null);

    const friend = sell(w, { phone: phone(2), regNo: plate(2), referralCode: a.referral_code }, later(1));
    assert.equal(friend.referral, null);
    assert.deepEqual([count(w.db, 'referrals'), count(w.db, 'grants')], [0, 0]);
  });

  test('an invitation made before referrals were switched off earns nobody anything, and is not used up', () => {
    const w = world();
    const a = referrer(w);
    assert.equal(store.linkReferral(w.db, w.cfg, phone(2), a, T0), 'linked');

    // the owner then sets maxPerYear to 0; the database, and the invitation in it, are the same
    const off = { db: w.db, cfg: configWith(s => { s.rewards.referral.maxPerYear = 0; }) };
    const friend = sell(off, { phone: phone(2), regNo: plate(2) }, later(1));
    assert.equal(friend.duplicate, false);
    assert.equal(friend.referral, null, 'no reward is announced at the counter');
    assert.equal(count(w.db, 'grants'), 0);
    assert.deepEqual(rows(w.db, 'SELECT referrer_id, friend_phone, converted_at FROM referrals'), [{ referrer_id: a.id, friend_phone: phone(2), converted_at: null }]);
    assert.equal(store.convertReferral(w.db, off.cfg, customer(w, friend.customerId), plate(2), later(1)), null);
    assert.equal(count(w.db, 'audit', "action LIKE 'referral.%'"), 0);
  });

  test('a referrer is rewarded for a new friend even after an earlier friend deleted their data', () => {
    const w = world();
    const a = referrer(w);
    const f1 = sell(w, { phone: phone(2), regNo: plate(2), referralCode: a.referral_code }, later(1));
    assert.equal(f1.referral.referrerGot, true);
    store.deleteCustomer(w.db, customer(w, f1.customerId), 'customer', later(2));
    assert.equal(referralGrants(w.db, a.id).length, 1, 'the reward already earned stays');

    const f2 = sell(w, { phone: phone(3), regNo: plate(3), referralCode: a.referral_code }, later(3));
    assert.notEqual(f2.customerId, f1.customerId, "the new friend was given the deleted friend's row id");
    assert.equal(f2.referral.friendGot, true);
    assert.equal(f2.referral.referrerGot, true, `the referrer was told: ${f2.referral.why}`);
    assert.equal(referralGrants(w.db, a.id).length, 2);
  });
});

/* ---------- reminders ---------- */

describe('reminders', () => {
  // a car whose replacement estimate is `daysLeft` days away at T0
  const dueIn = (w, n, daysLeft, extra) => sell(w, { phone: phone(n), regNo: plate(n), fittedOn: ago(REPLACE_AFTER - daysLeft), ...extra });
  const list = (w, now = T0) => dueItems(w.db, w.cfg, now, BASE);

  test('tyres appear on the replacement list once they are within the lead time, soonest first', () => {
    const w = world();
    dueIn(w, 1, 31, { remindersOk: true });     // a day too early
    const soon = dueIn(w, 2, 30, { remindersOk: true });
    const overdue = dueIn(w, 3, -30, { remindersOk: true });    // a month overdue
    dueIn(w, 4, -366, { remindersOk: true });   // more than a year overdue: no longer chased

    const items = list(w);
    assert.deepEqual(items.map(i => [i.regNo, i.type, i.daysLeft, i.dueOn]), [
      [plate(3), 'replacement', -30, ago(30)],
      [plate(2), 'replacement', 30, est.addDays(TODAY, 30)],
    ]);
    for (const item of items) {
      assert.equal(item.status, 'ready');
      assert.equal(item.statusAt, null);
      assert.equal('follow' in item, false, 'there is one note per set of tyres and no follow-up');
      assert.equal(item.basis, 'typical');
    }
    // one key per set of tyres, and every item says which vehicle and customer it is about
    assert.deepEqual(items.map(i => [i.key, i.saleId, i.vehicleId, i.customerId]), [
      [`rep:${overdue.saleId}:1`, overdue.saleId, overdue.vehicleId, overdue.customerId],
      [`rep:${soon.saleId}:1`, soon.saleId, soon.vehicleId, soon.customerId],
    ]);
  });

  test('only customers who agreed get a prepared message and a WhatsApp link; the others are listed without', () => {
    const w = world();
    const yes = dueIn(w, 1, 20, { remindersOk: true });
    const no = dueIn(w, 2, 19);
    const stopped = dueIn(w, 3, 18, { remindersOk: true });
    store.setReminders(w.db, w.cfg, customer(w, stopped.customerId), false, 'customer', T0);

    const items = list(w);
    assert.equal(items.length, 3);
    const of = r => items.find(i => i.customerId === r.customerId);

    const agreed = of(yes);
    assert.equal(agreed.consent, 'yes');
    assert.equal(typeof agreed.message, 'string');
    const stopUrl = `${BASE}/stop/${customer(w, yes.customerId).stop_token}`;
    assert.ok(agreed.message.includes('Hindustan Tyre Agencies'));
    assert.ok(agreed.message.includes('PB 00 TS 0001'), 'the message names the vehicle');
    assert.ok(agreed.message.includes(stopUrl), 'the message carries the way to stop');
    const wa = new URL(agreed.waUrl);
    assert.equal(wa.origin + wa.pathname, 'https://wa.me/915550000001');
    assert.equal(wa.searchParams.get('text'), agreed.message);

    for (const [sale, state] of [[no, 'no'], [stopped, 'stopped']]) {
      const item = of(sale);
      assert.equal(item.consent, state);
      assert.equal(item.type, 'replacement');
      assert.equal(item.phone, customer(w, sale.customerId).phone, 'staff can still see who is due');
      assert.equal('message' in item, false, `a message was prepared for a customer whose consent is "${state}"`);
      assert.equal('waUrl' in item, false, `a WhatsApp link was prepared for a customer whose consent is "${state}"`);
    }
  });

  test('a reminder can be marked only when its key is due and the customer agreed', () => {
    const w = world();
    const yes = dueIn(w, 1, 20, { remindersOk: true });
    const no = dueIn(w, 2, 19);
    const stopped = dueIn(w, 3, 18, { remindersOk: true });
    store.setReminders(w.db, w.cfg, customer(w, stopped.customerId), false, 'customer', T0);
    const mark = (key, status = 'marked_sent') => markReminder(w.db, w.cfg, key, status, T0 + MIN, BASE);

    assert.equal(mark(`rep:${no.saleId}:1`), null, 'never agreed');
    assert.equal(mark(`rep:${stopped.saleId}:1`), null, 'stopped');
    assert.equal(mark('rep:424242:1'), null, 'no such sale');
    assert.equal(mark(`rep:${yes.saleId}:2`), null, 'there is no second note');
    assert.equal(mark(`svc:${yes.saleId}:${TODAY}`), null, 'a service reminder that is not due');
    assert.equal(mark(`svc:${yes.saleId}:${ago(REPLACE_AFTER - 20)}`), null, 'a service reminder keyed by the fitting day, for tyres about to be replaced');
    for (const junk of ['', 'rep', `rep:${yes.saleId}:3`, `rep:${yes.saleId}:1 `, `rep:${yes.saleId}:1' OR '1'='1`, 42, null, undefined, { key: `rep:${yes.saleId}:1` }]) {
      assert.equal(mark(junk), null, `accepted ${JSON.stringify(junk)}`);
    }
    assert.equal(count(w.db, 'reminder_log'), 0);

    const done = mark(`rep:${yes.saleId}:1`, 'opened');
    assert.equal(done.status, 'opened');
    assert.equal(done.statusAt, T0 + MIN);
    assert.deepEqual(list(w).map(i => [i.customerId, i.status]).sort(), [[yes.customerId, 'opened'], [no.customerId, 'ready'], [stopped.customerId, 'ready']].sort());
    assert.deepEqual(rows(w.db, 'SELECT key, customer_id, status, at FROM reminder_log'), [{ key: `rep:${yes.saleId}:1`, customer_id: yes.customerId, status: 'opened', at: T0 + MIN }]);
  });

  test('the log holds only what a person at the shop did: opened, marked sent or skipped', () => {
    const w = world();
    const s = dueIn(w, 1, 20, { remindersOk: true });
    const key = `rep:${s.saleId}:1`;
    const stored = () => rows(w.db, 'SELECT status FROM reminder_log').map(r => r.status);

    assert.equal(list(w)[0].status, 'ready', 'nothing is claimed before anyone touched it');
    for (const status of ['opened', 'skipped', 'marked_sent']) {
      assert.equal(markReminder(w.db, w.cfg, key, status, T0, BASE).status, status);
      assert.deepEqual(stored(), [status]);
      assert.equal(list(w)[0].status, status);
    }
    // the database itself refuses anything else, so no code path can ever record a plain "sent"
    for (const invented of ['sent', 'delivered', 'read', 'ready', '']) {
      assert.throws(() => markReminder(w.db, w.cfg, key, invented, T0, BASE), /constraint/i, `"${invented}" was accepted as a status`);
      assert.deepEqual(stored(), ['marked_sent']);
    }
  });

  test('there is one note and no follow-up: once it is marked sent nothing more is prepared, however long the tyres stay on', () => {
    const w = world();
    const s = dueIn(w, 1, 10, { remindersOk: true });
    const first = `rep:${s.saleId}:1`, second = `rep:${s.saleId}:2`;
    const shown = now => list(w, now).map(i => [i.key, i.status, i.statusAt]);
    const stored = () => rows(w.db, 'SELECT key, status, at FROM reminder_log');

    assert.ok(markReminder(w.db, w.cfg, first, 'marked_sent', T0, BASE));
    // 30 days on with the date passed is when a second note used to be prepared; 375 days on is the last day on the list
    for (const days of [29, 30, 31, 120, 375]) {
      assert.deepEqual(shown(later(days)), [[first, 'marked_sent', T0]], `${days} days after the note was marked sent`);
      const item = list(w, later(days))[0];
      assert.equal('follow' in item, false);
      assert.match(item.message, /^Hindustan Tyre Agencies here\. /, 'the wording is the first note, not "A second note from ..."');
    }
    assert.deepEqual(shown(later(376)), [], 'more than a year past the date, the tyres are no longer chased');

    // a second note cannot be logged by hand either, whatever the day
    for (const days of [0, 30, 120]) assert.equal(markReminder(w.db, w.cfg, second, 'marked_sent', later(days), BASE), null, `${second} was accepted ${days} days on`);
    assert.deepEqual(stored(), [{ key: first, status: 'marked_sent', at: T0 }]);

    // the one note stays the one row: what was done with it can still be put right while the tyres are on the list
    assert.equal(markReminder(w.db, w.cfg, first, 'skipped', later(31), BASE).status, 'skipped');
    assert.deepEqual(stored(), [{ key: first, status: 'skipped', at: later(31) }]);
    assert.deepEqual(shown(later(45)), [[first, 'skipped', later(31)]]);
    assert.equal(markReminder(w.db, w.cfg, first, 'opened', later(376), BASE), null, 'and no longer once they have dropped off it');
  });

  test('a logged note is set aside when a later reading moves the date more than twice the lead time past the day it was logged', () => {
    for (const lead of [30, 10]) {
      const w = world(s => { s.reminders.replacementLeadDays = lead; });
      // Two cars fitted 1365 days ago: by typical wear each is due in 5 days, and both notes are marked sent today.
      // An hour later the odometer shows each customer drives less than typical, which puts one date exactly
      // twice the lead time from today and the other a day further out. (With only an odometer reading the date
      // is fitting day + days so far x 45,000 km / km so far.)
      const FITTED = REPLACE_AFTER - 5;
      const [kept, setAside] = [2 * lead, 2 * lead + 1].map((daysOut, i) => {
        const s = sell(w, { phone: phone(i + 1), regNo: plate(i + 1), fittedOn: ago(FITTED), remindersOk: true });
        assert.ok(markReminder(w.db, w.cfg, `rep:${s.saleId}:1`, 'marked_sent', T0, BASE));
        visit(w, { vehicleId: s.vehicleId, odometerKm: CAR.odometerKm + Math.round(FITTED * 45000 / (FITTED + daysOut)) }, T0 + HOUR);
        return { key: `rep:${s.saleId}:1`, dueOn: est.addDays(TODAY, daysOut) };
      });
      assert.deepEqual(list(w, T0 + HOUR), [], `lead ${lead}: neither is within the lead time any more`);

      // when the new dates come round, both are back on the list under the key they always had
      const back = later(lead + 1);
      assert.deepEqual(list(w, back).map(i => [i.key, i.dueOn, i.status, i.statusAt]), [
        [kept.key, kept.dueOn, 'marked_sent', T0],        // exactly twice the lead time: the note still stands
        [setAside.key, setAside.dueOn, 'ready', null],    // a day more: that note was about another date
      ], `lead ${lead}`);

      // marking it again re-dates the one row, and from then on the new note stands
      assert.equal(markReminder(w.db, w.cfg, setAside.key, 'marked_sent', back, BASE).statusAt, back);
      assert.deepEqual(rows(w.db, 'SELECT key, status, at FROM reminder_log ORDER BY key'), [
        { key: kept.key, status: 'marked_sent', at: T0 },
        { key: setAside.key, status: 'marked_sent', at: back },
      ]);
      assert.deepEqual(list(w, back + DAY_MS).map(i => [i.key, i.status, i.statusAt]), [[kept.key, 'marked_sent', T0], [setAside.key, 'marked_sent', back]]);
    }
  });

  test('services that fall due together go out as one message', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), fittedOn: ago(SERVICE_AFTER - 2), remindersOk: true });
    sell(w, { phone: phone(2), regNo: plate(2), fittedOn: ago(SERVICE_AFTER - 8), remindersOk: true });   // 8 days to go: outside the 7 day lead

    const items = list(w);
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.type, 'service');
    assert.equal(item.regNo, plate(1));
    assert.deepEqual([item.saleId, item.vehicleId, item.customerId], [s.saleId, s.vehicleId, s.customerId]);
    assert.deepEqual(item.services, ['Tyre rotation', 'Alignment check']);
    assert.equal(item.daysLeft, 2);
    assert.equal(item.dueOn, est.addDays(TODAY, 2));
    assert.equal(item.key, `svc:${s.saleId}:${ago(SERVICE_AFTER - 2)}`, 'neither has been done yet, so the round is named after the fitting day, not the due date');
    assert.deepEqual(item.free, []);
    assert.match(item.message, /tyre rotation and alignment check/);
    assert.ok(item.message.includes(`${BASE}/stop/${customer(w, s.customerId).stop_token}`));

    // once one of them is done only the other is still asked for, and when both are done the reminder is gone
    visit(w, { vehicleId: s.vehicleId, services: ['rotation'] });
    assert.deepEqual(list(w).map(i => [i.key, i.services]), [[item.key, ['Alignment check']]]);
    visit(w, { vehicleId: s.vehicleId, services: ['alignment-check'] }, T0 + HOUR);
    assert.deepEqual(list(w), []);
  });

  test('a free service waiting on the card is mentioned in the service reminder', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), fittedOn: ago(SERVICE_AFTER - 2), remindersOk: true });
    // an invited friend bought, so this customer holds a free tyre rotation
    sell(w, { phone: phone(2), regNo: plate(2), referralCode: customer(w, s.customerId).referral_code });

    const item = list(w).find(i => i.customerId === s.customerId);
    assert.deepEqual(item.free, ['Tyre rotation']);
    assert.match(item.message, /Free on your visit card: tyre rotation\./);
  });

  test('service reminders are only for the kinds of tyre they apply to', () => {
    const w = world();
    sell(w, { phone: phone(1), regNo: plate(1), tyre: 'CEAT Milaze', size: '90/100-10', qty: 2, fittedOn: ago(SERVICE_AFTER - 2), remindersOk: true });
    sell(w, { phone: phone(2), regNo: plate(2), tyre: 'Apollo EnduRace RA', size: '10.00 R20', qty: 6, fittedOn: ago(SERVICE_AFTER - 2), remindersOk: true });
    assert.deepEqual(list(w), []);
  });

  test('no service reminder goes out for tyres that are about to be replaced', () => {
    const w = world();
    const s = dueIn(w, 1, 20, { remindersOk: true });
    // both services were last done 150 days ago, so both are due again in two days
    visit(w, { vehicleId: s.vehicleId, services: ['rotation', 'alignment-check'], visitedOn: ago(SERVICE_AFTER - 2) }, T0, { backfill: true });
    const plan = store.passportFor(w.db, w.cfg, customer(w, s.customerId), T0).vehicles[0].current;
    assert.deepEqual(plan.services.map(x => [x.key, x.daysLeft]), [['rotation', 2], ['alignment-check', 2]]);

    assert.deepEqual(list(w).map(i => [i.type, i.key]), [['replacement', `rep:${s.saleId}:1`]]);
  });

  test('only the newest tyres on a vehicle are reminded about', () => {
    const w = world();
    const old = dueIn(w, 1, -30, { remindersOk: true });
    assert.deepEqual(list(w).map(i => i.saleId), [old.saleId]);
    sell(w, { phone: phone(1), regNo: plate(1), tyre: 'Apollo Alnac 4G', odometerKm: 64000 }, T0 + HOUR);
    assert.deepEqual(list(w, T0 + HOUR), []);
  });

  test('a service reminder already marked sent does not come back as ready before the service has been done', () => {
    const w = world();
    const fittedOn = ago(SERVICE_AFTER - 2);
    const s = sell(w, { phone: phone(1), regNo: plate(1), fittedOn, remindersOk: true });
    const sent = list(w)[0];
    assert.deepEqual(sent.services, ['Tyre rotation', 'Alignment check']);
    assert.equal(sent.dueOn, est.addDays(TODAY, 2));
    assert.ok(markReminder(w.db, w.cfg, sent.key, 'marked_sent', T0, BASE));

    // the customer drops in the next day with a puncture: the odometer is noted, the rotation is still not done.
    // 6,000 km in 151 days is more than typical, so 5,000 km was up 126 days after fitting: the date moves back 26 days
    visit(w, { vehicleId: s.vehicleId, odometerKm: 26000, services: ['puncture-repair'] }, later(1));
    const after = list(w, later(1));
    assert.deepEqual(after.map(i => [i.dueOn, i.daysLeft]), [[est.addDays(fittedOn, 126), -25]], 'set-up: the reading should have moved the date');
    assert.deepEqual(after.map(i => [i.key, i.services, i.status, i.statusAt]), [[sent.key, ['Tyre rotation', 'Alignment check'], 'marked_sent', T0]]);
    assert.equal(sent.key, `svc:${s.saleId}:${fittedOn}`);
    assert.equal(count(w.db, 'reminder_log'), 1);
  });

  test('once the service has been done, the next time it falls due is a new reminder under a new key', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), fittedOn: ago(SERVICE_AFTER - 2), remindersOk: true });
    const first = list(w)[0];
    assert.ok(markReminder(w.db, w.cfg, first.key, 'marked_sent', T0, BASE));

    // both are done three days later, and fall due again 152 days after that
    visit(w, { vehicleId: s.vehicleId, services: ['rotation', 'alignment-check'] }, later(3));
    assert.deepEqual(list(w, later(3)), []);
    const doneOn = est.addDays(TODAY, 3), dueAgain = 3 + SERVICE_AFTER;
    assert.deepEqual(list(w, later(dueAgain - 8)), [], 'eight days ahead is outside the lead time');
    const round2 = `svc:${s.saleId}:${doneOn}`;
    assert.deepEqual(list(w, later(dueAgain - 7)).map(i => [i.key, i.services, i.daysLeft, i.status, i.statusAt]),
      [[round2, ['Tyre rotation', 'Alignment check'], 7, 'ready', null]]);

    // the first round is over: its key can no longer be marked, and what was logged for it says nothing about this one
    assert.equal(markReminder(w.db, w.cfg, first.key, 'skipped', later(dueAgain - 7), BASE), null);
    assert.equal(markReminder(w.db, w.cfg, round2, 'opened', later(dueAgain - 7), BASE).status, 'opened');
    assert.deepEqual(rows(w.db, 'SELECT key, status FROM reminder_log ORDER BY at'), [{ key: first.key, status: 'marked_sent' }, { key: round2, status: 'opened' }]);
  });

  test('a reminder for a newly entered sale starts as ready, whatever was logged against a sale since removed', () => {
    const w = world();
    sell(w, { phone: phone(1), regNo: plate(1) });                                                         // keeps this customer on the books
    const mistake = sell(w, { phone: phone(1), regNo: plate(2), fittedOn: ago(REPLACE_AFTER - 10), remindersOk: true });   // an old bill typed in: due in 10 days
    assert.ok(markReminder(w.db, w.cfg, `rep:${mistake.saleId}:1`, 'marked_sent', T0 + MIN, BASE));
    store.voidSale(w.db, mistake.saleId, T0 + 2 * MIN);
    assert.equal(count(w.db, 'customers'), 1, 'set-up: the customer stays, so nothing here is removed just by the customer going');
    assert.equal(count(w.db, 'reminder_log'), 0, 'what was logged against the removed sale went with it');

    // somebody else's old bill is typed in next
    const other = dueIn(w, 2, 10, { remindersOk: true });
    assert.ok(other.saleId > mistake.saleId, "the new sale was given the removed sale's id");
    const item = list(w).find(i => i.customerId === other.customerId);
    assert.equal(item.status, 'ready', 'nobody at the shop has done anything with this reminder yet');
    assert.equal(item.statusAt, null);
  });
});

/* ---------- consent ---------- */

describe('consent to reminders', () => {
  const state = (w, id) => ({ ...w.db.q('SELECT reminders_ok, consent_at, consent_by, consent_notice, stopped_at FROM customers WHERE id = ?').get(id) });

  test('after a stop, staff cannot turn reminders back on, but the customer can', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), remindersOk: true });
    const me = () => customer(w, s.customerId);
    assert.equal(store.consentOf(me()), 'yes');

    assert.equal(store.setReminders(w.db, w.cfg, me(), false, 'customer', later(1)), 'off');
    assert.equal(store.consentOf(me()), 'stopped');
    assert.equal(state(w, s.customerId).stopped_at, later(1));

    assert.equal(store.setReminders(w.db, w.cfg, me(), true, 'staff', later(2)), 'stopped');
    assert.equal(state(w, s.customerId).reminders_ok, 0);
    // ticking the box on the next bill does not get round it either
    const nextSale = sell(w, { phone: phone(1), regNo: plate(2), remindersOk: true }, later(3));
    assert.equal(nextSale.consent, 'stopped');
    assert.equal(state(w, s.customerId).reminders_ok, 0);
    assert.equal(store.passportFor(w.db, w.cfg, me(), later(3)).reminders.state, 'stopped');

    assert.equal(store.setReminders(w.db, w.cfg, me(), true, 'customer', later(4)), 'on');
    assert.deepEqual(state(w, s.customerId), { reminders_ok: 1, consent_at: later(4), consent_by: 'customer', consent_notice: 'test-1', stopped_at: null });
    assert.equal(store.passportFor(w.db, w.cfg, me(), later(4)).reminders.state, 'yes');
  });

  test("a stop entered by staff at the customer's request is just as final for staff", () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), remindersOk: true });
    const me = () => customer(w, s.customerId);
    assert.equal(store.setReminders(w.db, w.cfg, me(), false, 'staff', later(1)), 'off');
    assert.equal(store.setReminders(w.db, w.cfg, me(), true, 'staff', later(1) + MIN), 'stopped');
    assert.equal(store.consentOf(me()), 'stopped');
  });

  test('staff can record a yes given at the counter for a customer who has never stopped', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1) });
    assert.equal(store.setReminders(w.db, w.cfg, customer(w, s.customerId), true, 'staff', later(1)), 'on');
    assert.deepEqual(state(w, s.customerId), { reminders_ok: 1, consent_at: later(1), consent_by: 'staff', consent_notice: 'test-1', stopped_at: null });
  });
});

/* ---------- putting mistakes right ---------- */

describe('removing a sale entered by mistake', () => {
  test('within a day, a sale for a brand new number is removed and leaves nothing behind', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), billNo: 'HTA/555' });
    addSession(w.db, phone(1));

    const out = store.voidSale(w.db, s.saleId, T0 + DAY_MS);   // exactly a day later is still in time
    assert.equal(out.customerId, null);
    const left = dump(w.db);
    for (const trace of [phone(1).slice(3), plate(1), 'HTA/555', s.token]) assert.ok(!left.includes(trace), `${trace} is still in the database`);
    for (const table of ['customers', 'vehicles', 'sales', 'visits', 'sessions']) assert.equal(count(w.db, table), 0, table);
  });

  test('after a day a sale can no longer be removed', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1) });
    refused(() => store.voidSale(w.db, s.saleId, T0 + DAY_MS + 1), 'sale', { message: /one day/ });
    refused(() => store.voidSale(w.db, 987654, T0), 'sale', { message: /not found/ });
    assert.deepEqual([count(w.db, 'customers'), count(w.db, 'vehicles'), count(w.db, 'sales'), count(w.db, 'visits')], [1, 1, 1, 1]);
  });

  test("removing one sale keeps the customer's other vehicle and its history", () => {
    const w = world();
    const kept = sell(w, { phone: phone(1), regNo: plate(1), fittedOn: ago(200) });
    const keptVisit = visit(w, { vehicleId: kept.vehicleId, odometerKm: 24000, treadMm: 6.4, visitedOn: ago(20) });
    const mistake = sell(w, { phone: phone(1), regNo: plate(2) });
    visit(w, { vehicleId: mistake.vehicleId, treadMm: 7.2 }, T0 + MIN);

    const out = store.voidSale(w.db, mistake.saleId, T0 + HOUR);
    assert.equal(out.customerId, kept.customerId);
    assert.deepEqual(rows(w.db, 'SELECT id, reg_no FROM vehicles'), [{ id: kept.vehicleId, reg_no: plate(1) }]);
    assert.deepEqual(rows(w.db, 'SELECT id FROM sales'), [{ id: kept.saleId }]);
    assert.deepEqual(rows(w.db, 'SELECT id, kind FROM visits ORDER BY id').map(v => v.kind), ['purchase', 'service']);
    assert.equal(count(w.db, 'visits', 'id = ?', keptVisit.visitId), 1);
    // the reading taken on the vehicle that never was had no earlier tyres to go back to: it went with the vehicle
    assert.equal(count(w.db, 'visits', 'vehicle_id = ?', mistake.vehicleId), 0);
  });

  test('visits logged after a removed sale are kept and handed back to the tyres that were on the vehicle before', () => {
    const w = world();
    const old = sell(w, { phone: phone(1), regNo: plate(1), fittedOn: ago(400) });
    // a sale typed against this vehicle by mistake, and then a real visit: a reading and a rotation
    const mistake = sell(w, { phone: phone(1), regNo: plate(1), tyre: 'Apollo Alnac 4G', odometerKm: 31000 }, T0 + HOUR);
    const reading = visit(w, { vehicleId: old.vehicleId, odometerKm: 31040, treadMm: 5.9, services: ['rotation'] }, T0 + 2 * HOUR);
    assert.equal(w.db.q('SELECT sale_id FROM visits WHERE id = ?').get(reading.visitId).sale_id, mistake.saleId, 'set-up: the visit was logged against the newest tyres');

    const out = store.voidSale(w.db, mistake.saleId, T0 + 3 * HOUR);
    assert.equal(out.customerId, old.customerId);
    assert.deepEqual(rows(w.db, 'SELECT id FROM sales'), [{ id: old.saleId }]);
    assert.deepEqual(rows(w.db, 'SELECT id, reg_no FROM vehicles'), [{ id: old.vehicleId, reg_no: plate(1) }]);
    // of the removed sale's visits only its own purchase entry went
    assert.deepEqual(rows(w.db, 'SELECT kind, sale_id, visited_on, odometer_km, tread_mm, services FROM visits ORDER BY id'), [
      { kind: 'purchase', sale_id: old.saleId, visited_on: ago(400), odometer_km: 20000, tread_mm: null, services: '[]' },
      { kind: 'service', sale_id: old.saleId, visited_on: TODAY, odometer_km: 31040, tread_mm: 5.9, services: '["rotation"]' },
    ]);
    assert.equal(count(w.db, 'visits', 'id = ?', reading.visitId), 1);

    // the passport is back on the old tyres, with the reading and the rotation counted for them
    const car = store.passportFor(w.db, w.cfg, customer(w, old.customerId), T0 + 3 * HOUR).vehicles[0];
    assert.equal(car.current.id, old.saleId);
    assert.deepEqual(car.earlier, []);
    assert.deepEqual([car.current.estimate.basis, car.current.estimate.lastReadingMm, car.current.estimate.lastReadingOn], ['readings', 5.9, TODAY]);
    assert.equal(car.current.services.find(x => x.key === 'rotation').lastDoneOn, TODAY);
    assert.deepEqual(car.history.map(h => [h.kind, h.saleId]), [['service', old.saleId], ['purchase', old.saleId]]);
  });

  test("removing a sale removes what was logged against its reminders, and nobody else's", () => {
    const w = world();
    // eleven old bills typed in today with a yes to reminders: all due for replacement in ten days, except the
    // second, which is only due for its services. Sale 1 and sale 11 are there because "1" is how "11" starts.
    const sales = [];
    for (let n = 1; n <= 11; n++) sales.push(sell(w, { phone: phone(n), regNo: plate(n), fittedOn: ago(n === 2 ? SERVICE_AFTER - 2 : REPLACE_AFTER - 10), remindersOk: true }, T0 + n));
    const [one, two] = sales, eleven = sales[10];
    assert.ok(String(eleven.saleId).startsWith(String(one.saleId)) && eleven.saleId !== one.saleId, 'set-up: one sale id should be the start of another');
    // the first two customers each bought again for another vehicle, so they stay on the books when the old bill is removed
    sell(w, { phone: phone(1), regNo: plate(101) }, T0 + 20);
    sell(w, { phone: phone(2), regNo: plate(102) }, T0 + 21);

    const now = T0 + HOUR;
    for (const item of dueItems(w.db, w.cfg, now, BASE)) assert.ok(markReminder(w.db, w.cfg, item.key, 'marked_sent', now, BASE), item.key);
    const logged = () => rows(w.db, 'SELECT key FROM reminder_log').map(r => r.key).sort();
    const others = sales.slice(2).map(s => `rep:${s.saleId}:1`).sort();
    assert.deepEqual(logged(), [`rep:${one.saleId}:1`, `svc:${two.saleId}:${ago(SERVICE_AFTER - 2)}`, ...others].sort());

    store.voidSale(w.db, one.saleId, now + MIN);
    store.voidSale(w.db, two.saleId, now + MIN);
    assert.equal(count(w.db, 'customers'), 11, 'set-up: nobody was removed, so nothing went just because a customer did');
    assert.deepEqual(logged(), others);
  });

  test('a yes to reminders ticked on the removed sale is undone; a yes given any other way, and a stop, stay', () => {
    const w = world();
    const state = id => ({ ...w.db.q('SELECT reminders_ok, consent_at, consent_by, consent_notice, stopped_at FROM customers WHERE id = ?').get(id) });
    const entered = T0 + HOUR, removed = T0 + 2 * HOUR;

    // ticked on the sale that is then removed: back to never having been asked
    const a = sell(w, { phone: phone(1), regNo: plate(1) });
    const aMistake = sell(w, { phone: phone(1), regNo: plate(2), remindersOk: true }, entered);
    assert.equal(aMistake.consent, 'yes');
    store.voidSale(w.db, aMistake.saleId, removed);
    assert.deepEqual(state(a.customerId), { reminders_ok: 0, consent_at: null, consent_by: null, consent_notice: null, stopped_at: null });
    assert.equal(store.consentOf(customer(w, a.customerId)), 'no', 'not "stopped": staff can still record a yes given at the counter');

    // ticked on an earlier sale: removing a later one, ticked as well, leaves the yes and its date
    const b = sell(w, { phone: phone(2), regNo: plate(3), remindersOk: true });
    const bMistake = sell(w, { phone: phone(2), regNo: plate(4), remindersOk: true }, entered);
    store.voidSale(w.db, bMistake.saleId, removed);
    assert.deepEqual(state(b.customerId), { reminders_ok: 1, consent_at: T0, consent_by: 'staff', consent_notice: 'test-1', stopped_at: null });

    // given by the customer on their own phone, even at the very moment the sale was entered
    const c = sell(w, { phone: phone(3), regNo: plate(5) });
    const cMistake = sell(w, { phone: phone(3), regNo: plate(6) }, entered);
    assert.equal(store.setReminders(w.db, w.cfg, customer(w, c.customerId), true, 'customer', entered), 'on');
    store.voidSale(w.db, cMistake.saleId, removed);
    assert.deepEqual(state(c.customerId), { reminders_ok: 1, consent_at: entered, consent_by: 'customer', consent_notice: 'test-1', stopped_at: null });

    // a customer who stopped stays stopped: the tick on the removed sale never counted, and removing it changes nothing
    const d = sell(w, { phone: phone(4), regNo: plate(7), remindersOk: true });
    store.setReminders(w.db, w.cfg, customer(w, d.customerId), false, 'customer', T0 + MIN);
    const dMistake = sell(w, { phone: phone(4), regNo: plate(8), remindersOk: true }, entered);
    assert.equal(dMistake.consent, 'stopped');
    store.voidSale(w.db, dMistake.saleId, removed);
    assert.equal(store.consentOf(customer(w, d.customerId)), 'stopped');
    assert.equal(state(d.customerId).stopped_at, T0 + MIN);
  });

  test('a reward earned with a removed sale stays, and entering the sale again does not earn it twice', () => {
    const w = world();
    const first = sell(w, { phone: phone(1), regNo: plate(1) });                 // stamp 1
    const second = sell(w, { phone: phone(1), regNo: plate(2) }, later(1));      // stamp 2
    assert.deepEqual(second.earned, ['Pressure and tread check']);

    store.voidSale(w.db, second.saleId, later(1) + MIN);
    assert.deepEqual(card(w, first.customerId).available.map(g => g.name), ['Pressure and tread check']);

    const again = sell(w, { phone: phone(1), regNo: plate(2) }, later(1) + 10 * MIN);
    assert.equal(again.duplicate, false);
    assert.deepEqual(again.earned, []);
    assert.equal(count(w.db, 'grants'), 1);
    assert.equal(card(w, first.customerId).stamps, 2);
  });

  test("removing a referred friend's first sale and entering it again leaves each of them with one free service", () => {
    const w = world();
    const a = customer(w, sell(w, { phone: phone(1), regNo: plate(1) }).customerId);
    const joined = now => store.passportFor(w.db, w.cfg, a, now, { base: BASE }).referral.joined;
    const typo = sell(w, { phone: phone(2), regNo: plate(2), size: '185/60 R15', referralCode: a.referral_code }, later(1));
    assert.equal(typo.referral.friendGot, true);
    assert.equal(joined(later(1)), 1);

    // the invitation was typed in with the sale, so it goes with the sale, and so does what both of them earned
    store.voidSale(w.db, typo.saleId, later(1) + 5 * MIN);
    assert.deepEqual([count(w.db, 'referrals'), count(w.db, 'grants')], [0, 0]);
    assert.equal(joined(later(1) + 5 * MIN), 0);

    const again = sell(w, { phone: phone(2), regNo: plate(2), referralCode: a.referral_code }, later(1) + 10 * MIN);
    assert.deepEqual(again.referral, { service: 'Tyre rotation', friendGot: true, referrerGot: true, why: null });

    const friend = store.customerByPhone(w.db, phone(2));
    assert.equal(referralGrants(w.db, a.id).length, 1, 'the referrer has one free service for one friend');
    assert.equal(referralGrants(w.db, friend.id).length, 1, 'the friend has their free service');
    assert.equal(joined(later(1) + 10 * MIN), 1);
  });

  test('an invitation the friend already had is open again once their first sale is removed', () => {
    const w = world();
    const a = customer(w, sell(w, { phone: phone(1), regNo: plate(1) }).customerId);
    assert.equal(store.linkReferral(w.db, w.cfg, phone(2), a, T0), 'linked');   // the friend signed in from the invitation link
    const invitation = () => rows(w.db, 'SELECT referrer_id, friend_phone, created_at, converted_at FROM referrals');

    const typo = sell(w, { phone: phone(2), regNo: plate(2), size: '185/60 R15' }, later(3));
    assert.deepEqual(typo.referral, { service: 'Tyre rotation', friendGot: true, referrerGot: true, why: null });
    assert.deepEqual(invitation(), [{ referrer_id: a.id, friend_phone: phone(2), created_at: T0, converted_at: later(3) }]);
    addSession(w.db, phone(2));

    const out = store.voidSale(w.db, typo.saleId, later(3) + 5 * MIN);
    assert.equal(out.customerId, null);
    assert.deepEqual(invitation(), [{ referrer_id: a.id, friend_phone: phone(2), created_at: T0, converted_at: null }], 'the invitation is as it was before the sale');
    assert.equal(count(w.db, 'grants'), 0, "the friend's free service went with the friend, and the referrer's unused one with the sale");
    assert.equal(store.customerByPhone(w.db, phone(2)), undefined);
    assert.equal(count(w.db, 'sessions', 'phone = ?', phone(2)), 0);
    assert.equal(store.passportFor(w.db, w.cfg, a, later(4), { base: BASE }).referral.joined, 0);

    // entered again, correctly this time and with the referral box left empty: the invitation still counts, once
    const again = sell(w, { phone: phone(2), regNo: plate(2) }, later(3) + 10 * MIN);
    assert.deepEqual(again.referral, { service: 'Tyre rotation', friendGot: true, referrerGot: true, why: null });
    assert.deepEqual(referralGrants(w.db, a.id), [{ service: 'rotation', used_at: null }]);
    assert.deepEqual(referralGrants(w.db, again.customerId), [{ service: 'rotation', used_at: null }]);
    assert.deepEqual(invitation(), [{ referrer_id: a.id, friend_phone: phone(2), created_at: T0, converted_at: later(3) + 10 * MIN }]);
  });

  test('a wrong number typed for an invited friend leaves nothing behind once the sale is removed', () => {
    const w = world();
    const a = customer(w, sell(w, { phone: phone(1), regNo: plate(1) }).customerId);
    const wrong = sell(w, { phone: phone(7), regNo: plate(2), referralCode: a.referral_code }, later(1));
    assert.equal(wrong.referral.referrerGot, true);

    const out = store.voidSale(w.db, wrong.saleId, later(1) + MIN);
    assert.equal(out.customerId, null);
    assert.equal(count(w.db, 'referrals', 'friend_phone = ?', phone(7)), 0, 'the mistyped number is still stored as an invited friend');
    assert.ok(!dump(w.db).includes(phone(7).slice(3)));
    assert.deepEqual(referralGrants(w.db, a.id), [], 'nobody keeps a free service for a friend who never was');
  });

  test('a wrong number typed for an invited friend leaves nothing behind when two sales were entered on it and both are removed', () => {
    const w = world();
    const a = customer(w, sell(w, { phone: phone(1), regNo: plate(1) }).customerId);
    // tyres for two vehicles, both bills typed with the same wrong number
    const first = sell(w, { phone: phone(7), regNo: plate(2), referralCode: a.referral_code }, later(1));
    const second = sell(w, { phone: phone(7), regNo: plate(3) }, later(1) + 5 * MIN);

    assert.equal(store.voidSale(w.db, first.saleId, later(1) + 10 * MIN).customerId, first.customerId);
    assert.equal(store.voidSale(w.db, second.saleId, later(1) + 11 * MIN).customerId, null);
    assert.equal(store.customerByPhone(w.db, phone(7)), undefined);
    assert.equal(count(w.db, 'referrals', 'friend_phone = ?', phone(7)), 0, 'the mistyped number is still stored as an invited friend');
    assert.ok(!dump(w.db).includes(phone(7).slice(3)));
    assert.deepEqual(referralGrants(w.db, a.id), [], 'the referrer keeps a free service for a friend who never bought');
  });

  test("a free service the referrer has already used is not taken back when the friend's sale is removed", () => {
    const w = world();
    const a = customer(w, sell(w, { phone: phone(1), regNo: plate(1) }).customerId);
    const wrong = sell(w, { phone: phone(7), regNo: plate(2), referralCode: a.referral_code }, later(1));
    const reward = card(w, a.id).available[0];
    assert.equal(reward.source, 'referral');
    store.useGrant(w.db, reward.id, later(1) + MIN);

    store.voidSale(w.db, wrong.saleId, later(1) + 5 * MIN);
    assert.deepEqual(referralGrants(w.db, a.id), [{ service: 'rotation', used_at: later(1) + MIN }]);
    assert.deepEqual(card(w, a.id).used.map(g => g.id), [reward.id], 'the visit card still shows the service that was given');
    // the rest of the sale is gone all the same, mistyped number included
    assert.equal(count(w.db, 'referrals'), 0);
    assert.ok(!dump(w.db).includes(phone(7).slice(3)));
  });

  test('a referrer who has already used the free service for a friend is not given a second one when that sale is removed and entered again', () => {
    const w = world();
    const a = customer(w, sell(w, { phone: phone(1), regNo: plate(1) }).customerId);
    const typo = sell(w, { phone: phone(2), regNo: plate(2), size: '185/60 R15', referralCode: a.referral_code }, later(1));
    const reward = card(w, a.id).available[0];
    store.useGrant(w.db, reward.id, later(1) + MIN);

    store.voidSale(w.db, typo.saleId, later(1) + 5 * MIN);
    assert.deepEqual(referralGrants(w.db, a.id), [{ service: 'rotation', used_at: later(1) + MIN }], 'a service already given is not taken back');

    const again = sell(w, { phone: phone(2), regNo: plate(2), referralCode: a.referral_code }, later(1) + 10 * MIN);
    assert.equal(again.referral.friendGot, true, 'the friend still gets theirs');
    assert.deepEqual(referralGrants(w.db, a.id), [{ service: 'rotation', used_at: later(1) + MIN }], 'one friend, one free service for the referrer');
  });

  test('on a live database, a sale removed as a mistake is no longer in the database files', () => {
    const dir = tempDir();
    const live = liveApp(dir);
    const s = store.registerSale(live.db, live.cfg, { ...EMPTY_SALE, ...CAR, phone: '+919876500004', regNo: 'PB10HT2008', billNo: 'HTA/909' }, T0);
    const traces = ['9876500004', 'PB10HT2008', 'HTA/909', s.token];
    for (const trace of traces) assert.notDeepEqual(filesHolding(dir, trace), [], `set-up: ${trace} should be on disk before the sale is removed`);

    store.voidSale(live.db, s.saleId, T0 + MIN);
    for (const trace of traces) assert.deepEqual(filesHolding(dir, trace), [], `${trace} is still on disk`);
  });
});

describe('correcting a vehicle number', () => {
  test('a mistyped number is corrected and the history stays with the vehicle', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: 'PB00TS00O1' });
    visit(w, { vehicleId: s.vehicleId, treadMm: 7.1 }, later(1));

    assert.equal(store.renameVehicle(w.db, s.vehicleId, plate(1), later(2)), s.customerId);
    const view = store.passportFor(w.db, w.cfg, customer(w, s.customerId), later(2));
    assert.equal(view.vehicles.length, 1);
    assert.equal(view.vehicles[0].id, s.vehicleId);
    assert.equal(view.vehicles[0].regNo, plate(1));
    assert.equal(view.vehicles[0].current.id, s.saleId);
    assert.equal(view.vehicles[0].history.length, 2);
    assert.ok(!dump(w.db).includes('PB00TS00O1'), 'the wrong number is gone, including from the audit trail');
  });

  test('a vehicle cannot take a number the customer already has, and an unknown vehicle is refused', () => {
    const w = world();
    const one = sell(w, { phone: phone(1), regNo: plate(1) });
    const two = sell(w, { phone: phone(1), regNo: plate(2) }, T0 + HOUR);

    refused(() => store.renameVehicle(w.db, two.vehicleId, plate(1), later(1)), 'regNo', { message: /already has a vehicle/ });
    refused(() => store.renameVehicle(w.db, 987654, plate(3), later(1)), 'vehicle', { message: /not found/ });
    assert.deepEqual(rows(w.db, 'SELECT id, reg_no FROM vehicles ORDER BY id'), [{ id: one.vehicleId, reg_no: plate(1) }, { id: two.vehicleId, reg_no: plate(2) }]);

    // saving the form without changing the number is not an error
    assert.equal(store.renameVehicle(w.db, two.vehicleId, plate(2), later(1)), one.customerId);
  });
});

/* ---------- deleting a customer ---------- */

describe('deleting a customer', () => {
  test('every trace of the phone and vehicle numbers goes, sessions and invitations included, and nobody else is touched', () => {
    const w = world();
    // someone else, who invited the customer we are about to delete
    const inviterSale = sell(w, { phone: phone(9), regNo: plate(9), remindersOk: true });
    const inviter = customer(w, inviterSale.customerId);
    addSession(w.db, phone(9));
    addSession(w.db, null, 'staff');

    // the customer: invited, an old bill typed in, a reminder marked, a reading, a second vehicle, a card reward,
    // two friends invited (one bought, one has not yet), a breakdown and two sign-ins
    const s1 = sell(w, { phone: phone(1), regNo: plate(1), fittedOn: ago(REPLACE_AFTER - 10), billNo: 'HTA/777', amountPaise: 1850000, remindersOk: true, referralCode: inviter.referral_code });
    assert.equal(s1.referral.referrerGot, true);
    assert.ok(markReminder(w.db, w.cfg, `rep:${s1.saleId}:1`, 'marked_sent', T0, BASE));
    visit(w, { vehicleId: s1.vehicleId, odometerKm: 64000, treadMm: 3.1, services: ['rotation'] });
    const s2 = sell(w, { phone: phone(1), regNo: plate(2) }, later(1));
    assert.deepEqual(s2.earned, ['Pressure and tread check']);
    const me = store.customerByPhone(w.db, phone(1));
    const friend = sell(w, { phone: phone(2), regNo: plate(3), referralCode: me.referral_code }, later(1));
    assert.equal(store.linkReferral(w.db, w.cfg, phone(3), me, later(1)), 'linked');
    w.db.q('INSERT INTO breakdowns (customer_id, vehicle_id, lat, lng, accuracy_m, shop_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(me.id, s1.vehicleId, 30.9, 75.85, 20, 'ludhiana', later(1));
    addSession(w.db, phone(1));
    addSession(w.db, phone(1));

    const traces = [phone(1).slice(3), plate(1), plate(2), 'HTA/777', s1.token, s2.token, me.stop_token, me.referral_code];
    const before = dump(w.db);
    for (const trace of traces) assert.ok(before.includes(trace), `the test set-up should have stored ${trace}`);
    for (const table of ['vehicles', 'sales', 'visits', 'grants', 'reminder_log', 'breakdowns']) assert.ok(count(w.db, table, 'customer_id = ?', me.id) > 0, `set-up: ${table}`);
    assert.equal(count(w.db, 'referrals', 'referrer_id = ? OR friend_phone = ?', me.id, me.phone), 3);
    // even before deleting, the audit trail holds row ids only
    const auditText = JSON.stringify(rows(w.db, 'SELECT * FROM audit'));
    for (const trace of ['555000', 'PB00TS']) assert.ok(!auditText.includes(trace), 'a phone or vehicle number was written to the audit trail');

    store.deleteCustomer(w.db, me, 'customer', later(2));

    const left = dump(w.db);
    for (const trace of traces) assert.ok(!left.includes(trace), `${trace} is still in the database`);
    assert.equal(store.customerByPhone(w.db, phone(1)), undefined);
    for (const table of ['vehicles', 'sales', 'visits', 'grants', 'reminder_log', 'breakdowns']) assert.equal(count(w.db, table, 'customer_id = ?', me.id), 0, table);
    assert.equal(count(w.db, 'referrals'), 0, 'the invitation they took up, the one they made that was taken up, and the one still waiting');
    assert.ok(!left.includes(phone(3).slice(3)), 'the number of the friend who never took up the invitation is gone too');
    assert.equal(count(w.db, 'sessions', 'phone = ?', phone(1)), 0);

    // everyone else is as they were
    assert.equal(count(w.db, 'sessions'), 2, "the inviter's sign-in and the staff session");
    assert.deepEqual([count(w.db, 'vehicles', 'customer_id = ?', inviter.id), count(w.db, 'sales', 'customer_id = ?', inviter.id), count(w.db, 'visits', 'customer_id = ?', inviter.id)], [1, 1, 1]);
    assert.equal(referralGrants(w.db, inviter.id).length, 1, 'the inviter keeps the free service already earned');
    assert.deepEqual([count(w.db, 'sales', 'customer_id = ?', friend.customerId), referralGrants(w.db, friend.customerId).length], [1, 1]);
    assert.equal(store.consentOf(customer(w, inviter.id)), 'yes');

    // the deletion itself is on record, without saying who
    const entry = rows(w.db, "SELECT actor, detail, at FROM audit WHERE action = 'customer.delete'");
    assert.deepEqual(entry, [{ actor: 'customer', detail: null, at: later(2) }]);
  });

  test('on a live database, the deleted numbers are no longer in the database files: not straight after the delete, not after the next housekeeping', () => {
    const dir = tempDir();
    const live = liveApp(dir);
    const s = store.registerSale(live.db, live.cfg, { ...EMPTY_SALE, ...CAR, phone: '+919876500003', regNo: 'PB10HT2007' }, T0);
    assert.notDeepEqual(filesHolding(dir, '9876500003'), [], 'set-up: the number should be on disk before it is deleted');
    assert.notDeepEqual(filesHolding(dir, 'PB10HT2007'), [], 'set-up: the vehicle number should be on disk before it is deleted');

    // the write-ahead log is emptied as part of the delete itself, not whenever SQLite next gets round to it
    store.deleteCustomer(live.db, store.customerById(live.db, s.customerId), 'customer', T0 + HOUR);
    assert.deepEqual(filesHolding(dir, '9876500003'), [], 'straight after the delete');
    assert.deepEqual(filesHolding(dir, 'PB10HT2007'), [], 'straight after the delete');
    assert.equal(fs.statSync(path.join(dir, 'passport.sqlite-wal')).size, 0, 'the write-ahead log was not emptied');

    live.housekeeping();
    assert.deepEqual(filesHolding(dir, '9876500003'), []);
    assert.deepEqual(filesHolding(dir, 'PB10HT2007'), []);
  });

  test("the breakdown button's counters for that customer go too, and only theirs", () => {
    const w = world();
    const mine = sell(w, { phone: phone(1), regNo: plate(1) });
    const theirs = sell(w, { phone: phone(2), regNo: plate(2) });
    const counter = w.db.q('INSERT INTO throttle (key, count, window_start, locked_until, strikes) VALUES (?, 1, ?, 0, 0)');
    // the two counters the breakdown button keeps per customer id, for both customers, for an id that merely
    // starts with the same digits, and a counter of another kind
    const keep = [`bd:gap:${theirs.customerId}`, `bd:day:${theirs.customerId}`, `bd:gap:${mine.customerId}7`, `bd:day:${mine.customerId}7`, 'otp:all'];
    for (const key of [`bd:gap:${mine.customerId}`, `bd:day:${mine.customerId}`, ...keep]) counter.run(key, T0);

    store.deleteCustomer(w.db, customer(w, mine.customerId), 'customer', T0 + MIN);
    assert.deepEqual(rows(w.db, 'SELECT key FROM throttle ORDER BY key').map(r => r.key), [...keep].sort());
  });

  test('a row id is never handed out twice, so nothing kept under an old id can attach to somebody new', () => {
    const w = world();
    const a = customer(w, sell(w, { phone: phone(1), regNo: plate(1) }).customerId);
    const ID_TABLES = ['customers', 'vehicles', 'sales', 'visits', 'grants', 'referrals', 'breakdowns'];
    const ids = () => Object.fromEntries(ID_TABLES.map(t => [t, rows(w.db, `SELECT id FROM ${t} ORDER BY id`).map(r => r.id)]));
    // a friend buys, comes back the next day (which earns a card reward), invites someone and uses the breakdown
    // button: the newest row in every one of these tables is then theirs
    const everything = (n, day) => {
      const s = sell(w, { phone: phone(n), regNo: plate(n), referralCode: a.referral_code }, later(day));
      assert.deepEqual(visit(w, { vehicleId: s.vehicleId, services: ['rotation'] }, later(day + 1)).earned, ['Pressure and tread check']);
      assert.equal(store.linkReferral(w.db, w.cfg, phone(n + 50), customer(w, s.customerId), later(day + 1)), 'linked');
      w.db.q("INSERT INTO breakdowns (customer_id, vehicle_id, shop_id, created_at) VALUES (?, ?, 'ludhiana', ?)").run(s.customerId, s.vehicleId, later(day + 1));
      return s;
    };

    const gone = everything(2, 1);
    const used = ids();
    store.deleteCustomer(w.db, customer(w, gone.customerId), 'customer', later(3));
    const kept = ids();
    for (const t of ID_TABLES) assert.ok(!kept[t].includes(used[t].at(-1)), `set-up: the newest row in ${t} should have been the deleted customer's`);

    // the next customer does all the same things: every row made for them has an id nobody has had
    everything(3, 4);
    const now = ids();
    for (const t of ID_TABLES) {
      const fresh = now[t].filter(id => !kept[t].includes(id));
      assert.ok(fresh.length > 0, `set-up: ${t} should have new rows`);
      assert.ok(fresh.every(id => id > used[t].at(-1)), `${t}: id ${Math.min(...fresh)} was handed out a second time (ids up to ${used[t].at(-1)} had been used before)`);
    }
  });

  test('the number can come back afterwards as a brand new customer with an empty card', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1), remindersOk: true });
    visit(w, { vehicleId: s.vehicleId, services: ['rotation'] }, later(1));
    store.deleteCustomer(w.db, customer(w, s.customerId), 'staff', later(2));

    const back = sell(w, { phone: phone(1), regNo: plate(1) }, later(3));
    assert.equal(back.consent, 'no', 'an old yes does not survive deletion');
    assert.deepEqual(back.earned, []);
    assert.equal(card(w, back.customerId).stamps, 1);
    assert.equal(count(w.db, 'grants'), 0);
  });
});

/* ---------- housekeeping ---------- */

describe('housekeeping sweep', () => {
  test('expired sign-ins, codes, counters, stale invitations, old locations and old audit entries go; live ones stay', () => {
    const w = world();
    const s = sell(w, { phone: phone(1), regNo: plate(1) });
    const me = s.customerId;

    addSession(w.db, phone(1), 'customer', T0 - 1);
    addSession(w.db, phone(1), 'customer', T0 + HOUR);
    const device = w.db.q('INSERT INTO devices (token_hash, tag, created_at, expires_at) VALUES (?, ?, ?, ?)');
    device.run('device-expired', 'pin-tag', T0 - 91 * DAY_MS, T0 - 1);
    device.run('device-live', 'pin-tag', T0, T0 + HOUR);
    const otp = w.db.q('INSERT INTO otp_codes (phone_key, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)');
    otp.run('key-old', 'hash-old', T0 - 2 * DAY_MS, T0 - 2 * DAY_MS - 5 * MIN);
    otp.run('key-live', 'hash-live', T0 + 5 * MIN, T0);
    const counter = w.db.q('INSERT INTO throttle (key, count, window_start, locked_until, strikes) VALUES (?, ?, ?, ?, ?)');
    counter.run('counter-old', 3, T0 - 9 * DAY_MS, 0, 0);
    counter.run('counter-old-but-still-locked', 5, T0 - 9 * DAY_MS, T0 + HOUR, 2);
    counter.run('counter-recent', 1, T0 - HOUR, 0, 0);
    const invite = w.db.q('INSERT INTO referrals (referrer_id, friend_phone, created_at, converted_at) VALUES (?, ?, ?, ?)');
    invite.run(me, phone(11), T0 - 366 * DAY_MS, null);
    invite.run(me, phone(12), T0 - 364 * DAY_MS, null);
    invite.run(me, phone(13), T0 - 500 * DAY_MS, T0 - 499 * DAY_MS);
    const breakdown = w.db.q("INSERT INTO breakdowns (customer_id, vehicle_id, lat, lng, accuracy_m, shop_id, created_at) VALUES (?, NULL, 30.9, 75.8, 25, 'ludhiana', ?)");
    breakdown.run(me, T0 - 8 * DAY_MS);
    breakdown.run(me, T0 - 6 * DAY_MS);
    w.db.q("INSERT INTO audit (at, actor, action, detail) VALUES (?, 'staff', 'old.entry', NULL)").run(T0 - 366 * DAY_MS);

    assert.deepEqual(sweep(w.db, w.cfg, T0), { expired: 0 });

    assert.deepEqual(rows(w.db, 'SELECT expires_at FROM sessions'), [{ expires_at: T0 + HOUR }]);
    assert.deepEqual(rows(w.db, 'SELECT token_hash FROM devices'), [{ token_hash: 'device-live' }]);
    assert.deepEqual(rows(w.db, 'SELECT phone_key FROM otp_codes'), [{ phone_key: 'key-live' }]);
    assert.deepEqual(rows(w.db, 'SELECT key FROM throttle ORDER BY key').map(r => r.key), ['counter-old-but-still-locked', 'counter-recent'], 'a lock-out that is still running must survive');
    assert.deepEqual(rows(w.db, 'SELECT friend_phone FROM referrals ORDER BY friend_phone').map(r => r.friend_phone), [phone(12), phone(13)]);
    assert.deepEqual(rows(w.db, 'SELECT created_at FROM breakdowns'), [{ created_at: T0 - 6 * DAY_MS }], 'a breakdown location is kept for a week');
    assert.equal(count(w.db, 'audit', "action = 'old.entry'"), 0);
    assert.equal(count(w.db, 'audit', "action = 'sale.create'"), 1);
    assert.equal(count(w.db, 'customers'), 1);
  });

  const SEVEN_YEARS = 2557;   // days

  test('a customer with no visit for the configured number of years is deleted, and nobody else', () => {
    const w = world();   // seven years
    // every sale and visit here was entered on the day it happened
    const active = sell(w, { phone: phone(9), regNo: plate(9) }, backThen(SEVEN_YEARS + 60));
    const idle = sell(w, { phone: phone(1), regNo: plate(1), billNo: 'HTA/OLD', referralCode: customer(w, active.customerId).referral_code }, backThen(SEVEN_YEARS + 30));
    const almost = sell(w, { phone: phone(2), regNo: plate(2) }, backThen(SEVEN_YEARS - 30));
    const cameBack = sell(w, { phone: phone(3), regNo: plate(3) }, backThen(SEVEN_YEARS + 400));
    visit(w, { vehicleId: cameBack.vehicleId, services: ['puncture-repair'] }, backThen(30));
    visit(w, { vehicleId: active.vehicleId, services: ['puncture-repair'] }, backThen(10));   // the inviter is still a regular
    addSession(w.db, phone(1));
    addSession(w.db, phone(2));
    assert.deepEqual(rows(w.db, 'SELECT visited_on, created_at FROM visits WHERE customer_id = ?', idle.customerId), [{ visited_on: ago(SEVEN_YEARS + 30), created_at: backThen(SEVEN_YEARS + 30) }]);

    assert.deepEqual(sweep(w.db, w.cfg, T0), { expired: 1 });

    assert.deepEqual(rows(w.db, 'SELECT id FROM customers ORDER BY id').map(r => r.id), [active.customerId, almost.customerId, cameBack.customerId].sort((x, y) => x - y));
    const left = dump(w.db);
    for (const trace of [phone(1).slice(3), plate(1), 'HTA/OLD', idle.token]) assert.ok(!left.includes(trace), `${trace} is still in the database`);
    assert.deepEqual(rows(w.db, 'SELECT phone FROM sessions'), [{ phone: phone(2) }]);
    assert.equal(referralGrants(w.db, active.customerId).length, 1, "the inviter's reward is theirs to keep");

    // a second run finds nothing more to do
    assert.deepEqual(sweep(w.db, w.cfg, T0 + HOUR), { expired: 0 });
  });

  test('an old record typed in today is kept: idle means nothing happened and nothing was entered for that long', () => {
    const w = world();   // seven years
    // an old bill typed in today for a number the shop has never had: the customer row itself is new
    const newNumber = sell(w, { phone: phone(1), regNo: plate(1), fittedOn: ago(SEVEN_YEARS + 30) });
    // an old bill typed in today for a customer of long ago: only the entry is new
    const oldNumber = sell(w, { phone: phone(2), regNo: plate(2) }, backThen(SEVEN_YEARS + 400));
    sell(w, { phone: phone(2), regNo: plate(3), fittedOn: ago(SEVEN_YEARS + 5) });
    // the same two histories, each entered on the day it happened: nothing has been typed for either since
    const control = sell(w, { phone: phone(3), regNo: plate(4) }, backThen(SEVEN_YEARS + 30));
    const control2 = sell(w, { phone: phone(4), regNo: plate(5) }, backThen(SEVEN_YEARS + 400));
    sell(w, { phone: phone(4), regNo: plate(6) }, backThen(SEVEN_YEARS + 5));
    const left = () => rows(w.db, 'SELECT id FROM customers ORDER BY id').map(r => r.id);

    assert.deepEqual(sweep(w.db, w.cfg, T0), { expired: 2 });
    assert.deepEqual(left(), [newNumber.customerId, oldNumber.customerId]);
    assert.equal(customer(w, control.customerId), undefined);
    assert.equal(customer(w, control2.customerId), undefined);
    assert.deepEqual([count(w.db, 'sales', 'customer_id = ?', newNumber.customerId), count(w.db, 'sales', 'customer_id = ?', oldNumber.customerId)], [1, 2], 'the old bills themselves are still there');

    // the clock starts at the day they were typed in: seven years on from that, with no visit, they go like anyone else
    assert.deepEqual(sweep(w.db, w.cfg, later(SEVEN_YEARS - 1)), { expired: 0 });
    assert.deepEqual(sweep(w.db, w.cfg, later(SEVEN_YEARS + 1)), { expired: 2 });
    assert.deepEqual(left(), []);
  });

  test('the last visit is counted by its calendar day, and a number with no visit at all by when it was entered', () => {
    const w = world();   // seven years is 2556.75 days: at noon the cut-off falls at six in the evening, 2557 days back
    const left = () => rows(w.db, 'SELECT id FROM customers ORDER BY id').map(r => r.id);
    const dayBefore = sell(w, { phone: phone(1), regNo: plate(1) }, backThen(SEVEN_YEARS + 1));
    // bought and entered at noon on the cut-off day: six hours on the wrong side of the moment, but a visit that day still counts
    const cutOffDay = sell(w, { phone: phone(2), regNo: plate(2) }, backThen(SEVEN_YEARS));
    // a number on the books with no sale under it. The staff page cannot leave one behind, but the sweep must not rely on that
    const bare = store.ensureCustomer(w.db, phone(3), T0 - HOUR);
    const bareOld = store.ensureCustomer(w.db, phone(4), backThen(SEVEN_YEARS + 1));
    assert.deepEqual(left(), [dayBefore.customerId, cutOffDay.customerId, bare.id, bareOld.id]);

    assert.deepEqual(sweep(w.db, w.cfg, T0), { expired: 2 });
    assert.deepEqual(left(), [cutOffDay.customerId, bare.id]);
    // a day later that day has dropped out of the seven years
    assert.deepEqual(sweep(w.db, w.cfg, later(1)), { expired: 1 });
    assert.deepEqual(left(), [bare.id]);
  });

  test('the number of years comes from the settings', () => {
    const w = world(s => { s.privacy.deleteAfterInactiveYears = 1; });
    const gone = sell(w, { phone: phone(1), regNo: plate(1) }, backThen(400));
    const stays = sell(w, { phone: phone(2), regNo: plate(2) }, backThen(330));
    const typedToday = sell(w, { phone: phone(3), regNo: plate(3), fittedOn: ago(400) });
    assert.deepEqual(sweep(w.db, w.cfg, T0), { expired: 1 });
    assert.equal(customer(w, gone.customerId), undefined);
    assert.equal(customer(w, stays.customerId).phone, phone(2));
    assert.equal(customer(w, typedToday.customerId).phone, phone(3));
  });

  test('on a live database, housekeeping leaves no trace of an expired customer in the database files or in the copy it takes that day', () => {
    const dir = tempDir();
    const live = liveApp(dir);
    store.registerSale(live.db, live.cfg, { ...EMPTY_SALE, ...CAR, phone: '+919876500005', regNo: 'PB10HT2009' }, backThen(SEVEN_YEARS + 30));
    assert.notDeepEqual(filesHolding(dir, '9876500005'), [], 'set-up: the number should be on disk before housekeeping runs');

    assert.deepEqual(live.housekeeping(), { expired: 1 });
    assert.deepEqual(filesHolding(dir, '9876500005'), []);
    assert.deepEqual(filesHolding(dir, 'PB10HT2009'), []);
    const copy = fs.readFileSync(path.join(dir, 'backups', 'passport-2026-10-06.sqlite'));
    assert.ok(copy.length > 0 && !copy.includes('9876500005') && !copy.includes('PB10HT2009'), "the day's backup holds the deleted numbers");
  });
});

/* ---------- demo samples and live databases ---------- */

describe('demo sample data', () => {
  test('a demo app starts with sample customers that cannot be mistaken for real ones', () => {
    const app = demoApp();
    assert.equal(app.cfg.mode, 'demo');
    assert.equal(app.db.file, ':memory:');
    assert.equal(getMeta(app.db, 'demo_seeded'), '1');

    const phones = rows(app.db, 'SELECT phone FROM customers').map(r => r.phone);
    assert.ok(phones.length >= DEMO_SAMPLES.length);
    for (const p of phones) assert.match(p, /^\+91555\d{7}$/, 'no real Indian mobile number starts with 5');
    for (const v of rows(app.db, 'SELECT reg_no FROM vehicles')) assert.match(v.reg_no, /^PB00/, 'PB00 is not a real registration office');

    // the samples offered on the demo sign-in screen really exist
    for (const sample of DEMO_SAMPLES) {
      const c = store.customerByPhone(app.db, '+91' + sample.phone);
      assert.ok(c, `sample ${sample.phone} is missing`);
      assert.equal(count(app.db, 'vehicles', 'customer_id = ? AND reg_no = ?', c.id, sample.plate), 1);
    }
  });

  test('the demo due list shows agreed, not agreed and stopped customers, with messages only for those who agreed', () => {
    const app = demoApp();
    const items = dueItems(app.db, app.cfg, T0, 'http://127.0.0.1:4000');

    assert.deepEqual([...new Set(items.map(i => i.consent))].sort(), ['no', 'stopped', 'yes']);
    assert.ok(items.some(i => i.type === 'replacement') && items.some(i => i.type === 'service'), 'both kinds of reminder are on show');
    for (const item of items) {
      assert.equal(item.status, 'ready', 'nothing is shown as sent or opened before anyone did it');
      assert.match(item.key, item.type === 'replacement' ? /^rep:\d+:1$/ : /^svc:\d+:\d{4}-\d{2}-\d{2}$/);
      assert.equal(count(app.db, 'vehicles', 'id = ? AND customer_id = ? AND reg_no = ?', item.vehicleId, item.customerId, item.regNo), 1, 'the item points at its vehicle');
      if (item.consent === 'yes') {
        assert.ok(item.message.includes('http://127.0.0.1:4000/stop/'));
        assert.ok(item.waUrl.startsWith('https://wa.me/91555'));
      } else {
        assert.equal('message' in item, false);
        assert.equal('waUrl' in item, false);
      }
    }
    // housekeeping leaves the samples alone
    assert.deepEqual(app.housekeeping(), { expired: 0 });
    assert.equal(dueItems(app.db, app.cfg, T0, 'http://127.0.0.1:4000').length, items.length);
  });

  test('sample data refuses to load into a live database, which starts empty and stays empty', () => {
    const dir = tempDir();
    const live = liveApp(dir);
    assert.equal(live.cfg.mode, 'live');
    assert.equal(live.db.file, path.join(dir, 'passport.sqlite'));
    const empty = () => ['customers', 'vehicles', 'sales', 'visits', 'grants', 'breakdowns'].every(t => count(live.db, t) === 0);
    assert.ok(empty(), 'a live database starts with no customers');
    assert.equal(getMeta(live.db, 'demo_seeded'), null);

    assert.throws(() => seedDemo(live.db, live.cfg, T0), /demo database only/);
    // neither half of the guard can be talked round on its own
    const demoCfg = configWith();
    assert.throws(() => seedDemo(live.db, demoCfg, T0), /demo database only/, 'demo settings pointed at a database file');
    const memory = world();
    assert.throws(() => seedDemo(memory.db, live.cfg, T0), /demo database only/, 'live settings with an in-memory database');

    assert.ok(empty());
    assert.equal(count(memory.db, 'customers'), 0);
    assert.equal(getMeta(live.db, 'demo_seeded'), null);

    // a real customer saved on the live database is still the only one after a restart
    store.registerSale(live.db, live.cfg, { ...EMPTY_SALE, ...CAR, phone: '+919876500001', regNo: 'PB10HT2005' }, T0);
    live.close();
    const restarted = liveApp(dir);
    assert.deepEqual(rows(restarted.db, 'SELECT phone FROM customers'), [{ phone: '+919876500001' }]);
  });
});

describe('a new staff PIN on a live database', () => {
  test('signs every staff device out and lifts every PIN lock-out, and leaves customers and other counters alone', () => {
    const dir = tempDir();
    const first = liveApp(dir);
    const tag = getMeta(first.db, 'pin_tag');
    assert.match(tag, /^[A-Za-z0-9_-]{22}$/);
    const session = first.db.q('INSERT INTO sessions (token_hash, kind, phone, tag, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    session.run('staff-session', 'staff', null, tag, T0, T0, T0 + 12 * HOUR);
    session.run('customer-session', 'customer', '+919876500006', null, T0, T0, T0 + 30 * DAY_MS);
    first.db.q('INSERT INTO devices (token_hash, tag, created_at, expires_at) VALUES (?, ?, ?, ?)').run('remembered-browser', tag, T0, T0 + 90 * DAY_MS);
    // every kind of wrong-PIN counter, each in the middle of a lock-out, and two counters that have nothing to do with the PIN
    const counter = first.db.q('INSERT INTO throttle (key, count, window_start, locked_until, strikes) VALUES (?, 0, ?, ?, 1)');
    for (const key of ['pin:ip:some-address', 'pin:all', 'pin:day', 'pin:dev:some-browser', 'plate:some-phone', 'otp:all']) counter.run(key, T0, T0 + 12 * HOUR);
    const state = app => ({
      sessions: rows(app.db, 'SELECT token_hash FROM sessions ORDER BY token_hash').map(r => r.token_hash),
      devices: rows(app.db, 'SELECT token_hash FROM devices').map(r => r.token_hash),
      counters: rows(app.db, 'SELECT key FROM throttle ORDER BY key').map(r => r.key),
    });
    first.close();

    // a restart with the same PIN changes none of it
    const restarted = liveApp(dir);
    assert.equal(getMeta(restarted.db, 'pin_tag'), tag);
    assert.deepEqual(state(restarted), {
      sessions: ['customer-session', 'staff-session'],
      devices: ['remembered-browser'],
      counters: ['otp:all', 'pin:all', 'pin:day', 'pin:dev:some-browser', 'pin:ip:some-address', 'plate:some-phone'],
    });
    restarted.close();

    const changed = liveApp(dir, { STAFF_PIN: '27182845' });
    assert.notEqual(getMeta(changed.db, 'pin_tag'), tag);
    assert.deepEqual(state(changed), { sessions: ['customer-session'], devices: [], counters: ['otp:all', 'plate:some-phone'] });
  });
});

describe('daily backup of a live database', () => {
  test('one copy a day is kept for seven days, so deleted data leaves the backups within a week', () => {
    const dir = tempDir();
    const live = liveApp(dir);
    store.registerSale(live.db, live.cfg, { ...EMPTY_SALE, ...CAR, phone: '+919876500002', regNo: 'PB10HT2006' }, T0);

    const first = backup(live.db, live.cfg, T0);
    assert.equal(first, path.join(dir, 'backups', 'passport-2026-10-06.sqlite'));
    assert.ok(fs.statSync(first).size > 0);
    backup(live.db, live.cfg, T0 + HOUR);   // the same day again
    assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), ['passport-2026-10-06.sqlite']);

    for (let day = 1; day <= 8; day++) backup(live.db, live.cfg, later(day));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).sort(), [
      'passport-2026-10-08.sqlite', 'passport-2026-10-09.sqlite', 'passport-2026-10-10.sqlite', 'passport-2026-10-11.sqlite',
      'passport-2026-10-12.sqlite', 'passport-2026-10-13.sqlite', 'passport-2026-10-14.sqlite',
    ]);
  });

  test('the in-memory demo database is never written to disk', () => {
    const w = world();
    assert.equal(backup(w.db, w.cfg, T0), null);
  });
});
