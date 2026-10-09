'use strict';

/* Sample customers for demo mode. They exist only in the in-memory demo database, their phone numbers start
   with 555 (no real mobile does) and their plates use the RTO code PB00 (no such office), so none of it can
   be mistaken for, or collide with, a real person. Dates are set relative to today so the due list is never empty. */

const { setMeta } = require('./db');
const { DEMO_STAFF_PINS } = require('./config');
const est = require('./estimate');
const store = require('./store');
const stock = require('./stock');
const stats = require('./stats');

// shown on the demo sign-in screen
const DEMO_SAMPLES = [
  { phone: '5550000101', plate: 'PB00DM0001', note: 'Car. Three tread readings, replacement due soon.' },
  { phone: '5550000102', plate: 'PB00DM0002', note: 'Car. Fitted five months ago, rotation due.' },
  { phone: '5550000105', plate: 'PB00DM0005', note: 'Truck. One reading so far.' },
];

// sample staff accounts, shown on the demo sign-in screen beside the owner's PIN
const DEMO_STAFF = [{ name: 'Ravi (demo)', pin: DEMO_STAFF_PINS[0] }, { name: 'Simran (demo)', pin: DEMO_STAFF_PINS[1] }];
const DEMO_STOCK = [
  { size: '185/65 R15', qty: 3, minQty: 4 },
  { size: '215/60 R16', qty: 8, minQty: 4 },
  { size: '195/55 R16', qty: 0, minQty: 2 },
  { size: '165/80 R14', qty: 10, minQty: 4 },
  { size: '90/100-10', qty: 12, minQty: 6 },
  { size: '10.00 R20', qty: 5, minQty: 2 },
];

function seedDemo(db, cfg, now, extra = {}) {
  if (cfg.mode !== 'demo' || db.file !== ':memory:') throw new Error('sample data is for the in-memory demo database only');
  const today = store.todayFor(cfg, now);
  const ago = days => est.addDays(today, -days);
  const back = { backfill: true };
  const sale = input => store.registerSale(db, cfg, { fittedOn: today, billNo: null, amountPaise: null, warrantyMonths: null, newTreadMm: null, remindersOk: false, referralCode: null, confirm: false, idem: null, ...input }, now, back);
  const visit = input => store.logVisit(db, cfg, { odometerKm: null, treadMm: null, services: [], confirm: false, idem: null, ...input }, now, back);

  // 1. a car with three tread readings: the estimate is fitted to them and replacement is about three weeks out
  const a = sale({ phone: '+915550000101', regNo: 'PB00DM0001', tyre: 'MRF ZVTV', size: '185/65 R15', qty: 4, odometerKm: 21400, fittedOn: ago(1040), billNo: 'DEMO-1001', amountPaise: 2140000, remindersOk: true });
  visit({ vehicleId: a.vehicleId, visitedOn: ago(860), odometerKm: 27350, services: ['rotation', 'pressure-tread-check'] });
  visit({ vehicleId: a.vehicleId, visitedOn: ago(675), odometerKm: 33450, treadMm: 5.6, services: ['rotation', 'alignment-check'] });
  visit({ vehicleId: a.vehicleId, visitedOn: ago(495), odometerKm: 39500, services: ['rotation'] });
  visit({ vehicleId: a.vehicleId, visitedOn: ago(310), odometerKm: 45500, treadMm: 3.7, services: ['rotation', 'alignment-check'] });
  visit({ vehicleId: a.vehicleId, visitedOn: ago(135), odometerKm: 51550, treadMm: 2.8, services: ['rotation'] });
  // the first two free services on the card have been used
  for (const g of db.q("SELECT id FROM grants WHERE customer_id = ? AND source = 'card' ORDER BY id LIMIT 2").all(a.customerId)) db.q('UPDATE grants SET used_at = ? WHERE id = ?').run(now - 300 * 86400e3, g.id);

  // 2. a friend the first customer invited: both earned a free service. No readings yet; rotation is due.
  const code = db.q('SELECT referral_code AS c FROM customers WHERE id = ?').get(a.customerId).c;
  const b = sale({ phone: '+915550000102', regNo: 'PB00DM0002', tyre: 'Apollo Apterra HT2', size: '215/60 R16', qty: 4, odometerKm: 48200, fittedOn: ago(148), billNo: 'DEMO-1002', amountPaise: 3120000, remindersOk: true, referralCode: code });

  // 3. a scooter with no readings and no consent: on the list, but there is nobody to message
  sale({ phone: '+915550000103', regNo: 'PB00DM0003', tyre: 'CEAT Milaze', size: '90/100-10', qty: 2, odometerKm: 8600, fittedOn: ago(1120) });

  // 4. a car past its estimated date whose owner stopped reminders
  const d = sale({ phone: '+915550000104', regNo: 'PB00DM0004', tyre: 'JK UX Royale', size: '195/55 R16', qty: 4, odometerKm: 30900, fittedOn: ago(1400), remindersOk: true });
  store.setReminders(db, cfg, store.customerById(db, d.customerId), false, 'customer', now - 40 * 86400e3);

  // 5. a truck with one reading: nothing due yet
  const e = sale({ phone: '+915550000105', regNo: 'PB00DM0005', tyre: 'Apollo EnduRace RA', size: '10.00 R20', qty: 6, odometerKm: 184000, fittedOn: ago(300), billNo: 'DEMO-1005', amountPaise: 13200000, remindersOk: true });
  visit({ vehicleId: e.vehicleId, visitedOn: ago(45), odometerKm: 236000, treadMm: 9.8 });

  // 6. a car fitted last week and back for a free pressure check: this week's numbers on the owner's page
  const f = sale({ phone: '+915550000106', regNo: 'PB00DM0006', tyre: 'CEAT SecuraDrive', size: '165/80 R14', qty: 4, odometerKm: 36200, fittedOn: ago(4), billNo: 'DEMO-1006', amountPaise: 1480000, remindersOk: true });
  visit({ vehicleId: f.vehicleId, visitedOn: ago(2), odometerKm: 36400, services: ['pressure-tread-check'] });

  // a breakdown shared three hours ago, not yet seen by staff
  db.q('INSERT INTO breakdowns (customer_id, vehicle_id, lat, lng, accuracy_m, shop_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(b.customerId, b.vehicleId, 30.8721, 75.8912, 35, cfg.settings.shops[0].id, now - 3 * 3600e3);

  // the book says who entered what
  db.q("UPDATE sales SET entered_by = CASE WHEN id % 2 = 1 THEN 'staff:Ravi (demo)' ELSE 'owner' END").run();
  db.q("UPDATE visits SET entered_by = CASE WHEN id % 3 = 0 THEN 'staff:Simran (demo)' ELSE 'staff:Ravi (demo)' END").run();
  db.q("UPDATE sales SET entered_by = 'staff:Simran (demo)' WHERE id = ?").run(f.saleId);
  if (extra.staff) for (const m of DEMO_STAFF) extra.staff.create(db, m, 'system', now);
  for (const row of DEMO_STOCK) stock.count(db, row, 'system', now - 6 * 86400e3);
  // last week's sale came off the shelf count, as a sale at the desk would
  stock.onSale(db, { id: f.saleId, size: '165/80 R14', qty: 4 }, 'staff:Simran (demo)', now - 4 * 86400e3);
  stats.seedDemo(db, cfg, now);

  setMeta(db, 'demo_seeded', '1');
}

module.exports = { seedDemo, DEMO_SAMPLES, DEMO_STAFF, DEMO_STOCK };
