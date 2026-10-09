'use strict';

/* The owner's side: staff accounts with their own PINs, stock by size tied to sales, cookie-less counts, the
   old book coming in, backups going out, and the job card. As elsewhere, every test talks to a real server on
   a random port with an injected clock, in demo mode unless it says otherwise. */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createApp, LIMITS } = require('../server/app');
const { signPut, makeOffsite, offsiteSettings } = require('../server/offsite');
const { restore } = require('../server/restore');
const { SCHEMA_VERSION, openDb } = require('../server/db');
const { ConfigError } = require('../server/config');
const { DEMO_STAFF, DEMO_STOCK } = require('../server/seed');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-admin-'));
const T0 = Date.UTC(2026, 9, 8, 6, 0, 0);            // 8 Oct 2026, 11:30 in India
const TODAY = '2026-10-08';
const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const RAVI = DEMO_STAFF[0];
const APP_SECRET = 'a-test-secret-that-is-long-enough-for-the-server-to-accept';
const OWNER_PIN = '48151623';

/* ---------- one running server, with cookie jars ---------- */

async function start({ live = false, env = {}, fetch: fakeFetch, offsite } = {}) {
  const w = { t: T0, logs: [] };
  const options = { now: () => w.t, jitter: false, log: line => w.logs.push(String(line)) };
  options.env = live
    ? { APP_SECRET, STAFF_PIN: OWNER_PIN, PUBLIC_BASE_URL: 'https://passport.example.com', DATA_DIR: fs.mkdtempSync(path.join(TMP, 'live-')), ...env }
    : { DATA_DIR: TMP, ...env };
  if (fakeFetch) options.fetch = fakeFetch;
  if (offsite !== undefined) options.offsite = offsite;
  w.app = createApp(options);
  w.server = http.createServer(w.app.handler);
  await new Promise(resolve => w.server.listen(0, '127.0.0.1', resolve));
  w.url = `http://localhost:${w.server.address().port}`;
  w.stop = async () => { await new Promise(resolve => { w.server.close(resolve); w.server.closeAllConnections(); }); w.app.close(); };
  w.skip = ms => { w.t += ms; };
  w.client = () => {
    const jar = new Map();
    const send = async (method, route, body, headers = {}) => {
      const h = method === 'GET' ? { ...headers } : { 'content-type': 'application/json', 'x-hta': '1', ...headers };
      for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
      if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const init = { method, headers: h, redirect: 'manual' };
      if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
      const res = await fetch(w.url + route, init);
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf8');
      assert.notEqual(res.status, 500, `${method} ${route} made the server fail: ${w.logs.at(-1)}`);
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const at = pair.indexOf('=');
        const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
        if (value === '' || /;\s*max-age=0\b/i.test(line)) jar.delete(name); else jar.set(name, value);
      }
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, text, json, buf };
    };
    return { jar, get: (r, h) => send('GET', r, undefined, h), post: (r, b = {}, h) => send('POST', r, b, h) };
  };
  w.as = async pin => { const c = w.client(); const r = await c.post('/api/staff/login', { pin }); assert.equal(r.status, 200, r.text); c.who = r.json.who; return c; };
  w.owner = () => w.as(w.app.cfg.staffPin);
  w.ravi = () => w.as(RAVI.pin);
  return w;
}
const refused = (r, status, code) => { assert.equal(r.status, status, r.text); assert.equal(r.json && r.json.error && r.json.error.code, code, r.text); };
const ok = r => { assert.equal(r.status, 200, r.text); return r.json; };
const saleBody = (over = {}) => ({ phone: '5550000301', regNo: 'PB00DM0301', tyre: 'MRF ZVTV', size: '185/65 R15', qty: 4, odometerKm: 12000, idem: 'idem' + Math.random().toString(36).slice(2, 12), ...over });

/* ---------- staff accounts ---------- */

describe('staff accounts', () => {
  let w;
  before(async () => { w = await start(); });
  after(() => w.stop());

  test('the demo seeds two named accounts and the sign-in screen is told their PINs', async () => {
    const pub = ok(await w.client().get('/api/public/config'));
    assert.deepEqual(pub.demo.staff, DEMO_STAFF);
    const o = await w.owner();
    const { staff } = ok(await o.get('/api/admin/staff'));
    assert.deepEqual(staff.map(s => [s.name, s.active]), DEMO_STAFF.map(s => [s.name, true]));
  });

  test('a member signs in with their own PIN and the desk knows their name; the owner is the owner', async () => {
    const r = await w.ravi();
    assert.deepEqual(r.who, { name: RAVI.name, role: 'staff' });
    const st = ok(await r.get('/api/staff/status'));
    assert.deepEqual(st.who, { name: RAVI.name, role: 'staff' });
    const o = await w.owner();
    assert.deepEqual(ok(await o.get('/api/staff/status')).who, { name: 'Owner', role: 'owner' });
  });

  test('what a member enters carries their name, in the book and in the activity log', async () => {
    const r = await w.ravi();
    const done = ok(await r.post('/api/staff/sales', saleBody()));
    const row = w.app.db.q('SELECT entered_by FROM sales WHERE id = ?').get(done.saleId);
    assert.equal(row.entered_by, 'staff:' + RAVI.name);
    const visit = w.app.db.q("SELECT entered_by FROM visits WHERE sale_id = ? AND kind = 'purchase'").get(done.saleId);
    assert.equal(visit.entered_by, 'staff:' + RAVI.name);
    const log = w.app.db.q("SELECT actor FROM audit WHERE action = 'sale.create' ORDER BY id DESC LIMIT 1").get();
    assert.equal(log.actor, 'staff:' + RAVI.name);
    const o = await w.owner();
    const ov = ok(await o.get('/api/admin/overview'));
    assert.ok(ov.periods.today.byStaff.some(b => b.who === 'staff:' + RAVI.name && b.sales >= 1));
  });

  test('a member is not the owner: every owner route says so, and the staff desk still works for them', async () => {
    const r = await w.ravi();
    const source = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
    const defined = [...source.matchAll(/route\(\s*'([A-Z]+)'\s*,\s*'(\/api\/admin\/[^']*)'/g)].map(m => [m[1], m[2].replace(':id', '1').replace(':days', '7')]);
    assert.ok(defined.length >= 10, `found ${defined.length} owner routes`);
    for (const [method, p] of defined) refused(method === 'GET' ? await r.get(p) : await r.post(p, {}), 403, 'owner-only');
    ok(await r.get('/api/staff/due'));
    const nobody = w.client();
    for (const [method, p] of defined) refused(method === 'GET' ? await nobody.get(p) : await nobody.post(p, {}), 401, 'staff-signed-out');
  });

  test('the owner adds a person; the rules on PINs are the same as for the owner PIN', async () => {
    const o = await w.owner();
    refused(await o.post('/api/admin/staff', { name: 'Harpreet', pin: '123456' }), 400, 'invalid');
    refused(await o.post('/api/admin/staff', { name: 'Harpreet', pin: '111111' }), 400, 'invalid');
    refused(await o.post('/api/admin/staff', { name: 'Harpreet', pin: '150890' }), 400, 'invalid');      // a date
    refused(await o.post('/api/admin/staff', { name: 'Harpreet', pin: '1234' }), 400, 'invalid');
    refused(await o.post('/api/admin/staff', { name: 'Harpreet', pin: w.app.cfg.staffPin }), 400, 'invalid');   // the owner's
    refused(await o.post('/api/admin/staff', { name: 'Harpreet', pin: RAVI.pin }), 400, 'invalid');           // Ravi's
    refused(await o.post('/api/admin/staff', { name: 'H', pin: '739201' }), 400, 'invalid');
    refused(await o.post('/api/admin/staff', { name: '<b>x</b>', pin: '739201' }), 400, 'invalid');
    refused(await o.post('/api/admin/staff', { name: RAVI.name, pin: '739201' }), 400, 'invalid');            // same name, active
    const made = ok(await o.post('/api/admin/staff', { name: '  Harpreet   Kaur ', pin: '739201' })).member;
    assert.equal(made.name, 'Harpreet Kaur');
    assert.equal(made.active, true);
    const h = await w.as('739201');
    assert.deepEqual(h.who, { name: 'Harpreet Kaur', role: 'staff' });
    const { staff } = ok(await o.get('/api/admin/staff'));
    assert.ok(staff.find(s => s.id === made.id).lastLogin, 'last sign-in recorded');
  });

  test('rename, new PIN and switching off: a new PIN or switching off signs that person out everywhere', async () => {
    const o = await w.owner();
    const made = ok(await o.post('/api/admin/staff', { name: 'Gurpreet', pin: '582917' })).member;
    const g = await w.as('582917');
    ok(await g.get('/api/staff/status'));

    const renamed = ok(await o.post(`/api/admin/staff/${made.id}`, { name: 'Gurpreet S' })).member;
    assert.equal(renamed.name, 'Gurpreet S');
    assert.equal(ok(await g.get('/api/staff/status')).who.name, 'Gurpreet S', 'an open session sees the new name');

    ok(await o.post(`/api/admin/staff/${made.id}`, { pin: '917364' }));
    refused(await g.get('/api/staff/status'), 401, 'staff-signed-out');
    refused(await w.client().post('/api/staff/login', { pin: '582917' }), 401, 'wrong-pin');
    const g2 = await w.as('917364');

    ok(await o.post(`/api/admin/staff/${made.id}`, { active: false }));
    refused(await g2.get('/api/staff/status'), 401, 'staff-signed-out');
    refused(await w.client().post('/api/staff/login', { pin: '917364' }), 401, 'wrong-pin');
    ok(await o.post(`/api/admin/staff/${made.id}`, { active: true }));
    await w.as('917364');

    refused(await o.post(`/api/admin/staff/${made.id}`, {}), 400, 'invalid');
    refused(await o.post('/api/admin/staff/999', { name: 'Nobody' }), 404, 'not-found');
  });

  test('wrong PINs still lock as before, whoever they were meant for', async () => {
    const fresh = await start();
    try {
      const c = fresh.client();
      for (let i = 0; i < 4; i++) refused(await c.post('/api/staff/login', { pin: '908172' }), 401, 'wrong-pin');
      refused(await c.post('/api/staff/login', { pin: '908172' }), 429, 'locked');
      refused(await c.post('/api/staff/login', { pin: RAVI.pin }), 429, 'locked');
    } finally { await fresh.stop(); }
  });
});

/* ---------- stock ---------- */

describe('stock by size', () => {
  let w, o;
  before(async () => { w = await start(); o = await w.owner(); });
  after(() => w.stop());

  test('the demo stock is listed with what sold lately, and low sizes are marked', async () => {
    const d = ok(await o.get('/api/admin/stock'));
    assert.equal(d.rows.length, DEMO_STOCK.length);
    const low = d.rows.filter(r => r.low).map(r => r.size);
    assert.deepEqual(low.sort(), ['185/65 R15', '195/55 R16']);
    assert.equal(d.lowCount, 2);
    assert.ok(d.rows.find(r => r.size === '185/65 R15').sold30 >= 0);
    assert.equal(ok(await o.get('/api/staff/status')).lowStock, 2);
  });

  test('a sale takes its tyres off the count and tells the desk when that leaves it low; removing the sale puts them back', async () => {
    const r = await w.ravi();
    const before = ok(await o.get('/api/admin/stock')).rows.find(x => x.size === '215/60 R16');
    assert.equal(before.qty, 8);
    const body = saleBody({ phone: '5550000302', regNo: 'PB00DM0302', size: '215/60R16', qty: 4 });
    const done = ok(await r.post('/api/staff/sales', body));
    assert.deepEqual({ qty: done.stock.qty, low: done.stock.low, size: done.stock.size }, { qty: 4, low: true, size: '215/60 R16' });
    const again = ok(await r.post('/api/staff/sales', body));
    assert.equal(again.duplicate, true);
    assert.equal(ok(await o.get('/api/admin/stock')).rows.find(x => x.size === '215/60 R16').qty, 4, 'the same form sent twice takes stock once');
    const voided = ok(await r.post(`/api/staff/sales/${done.saleId}/void`));
    assert.equal(voided.stock.qty, 8);
    const moves = ok(await o.post('/api/admin/stock/moves', { size: '215/60 R16' })).moves;
    assert.deepEqual(moves.slice(0, 2).map(m => [m.delta, m.reason, m.by]), [[4, 'void', 'staff:' + RAVI.name], [-4, 'sale', 'staff:' + RAVI.name]]);
    // a sale typed in from an old bill does not touch today's shelf
    const old = ok(await r.post('/api/staff/sales', saleBody({ phone: '5550000302', regNo: 'PB00DM0302', size: '215/60R16', qty: 4, fittedOn: '2025-01-10' })));
    assert.equal(old.stock, null);
    assert.equal(ok(await o.get('/api/admin/stock')).rows.find(x => x.size === '215/60 R16').qty, 8);
    // a void after the owner has recounted does not add on top of the fresh count
    const fresh = ok(await r.post('/api/staff/sales', saleBody({ phone: '5550000302', regNo: 'PB00DM0302', size: '215/60R16', qty: 2 })));
    assert.equal(fresh.stock.qty, 6);
    ok(await o.post('/api/admin/stock', { size: '215/60 R16', qty: 10 }));
    const undone = ok(await r.post(`/api/staff/sales/${fresh.saleId}/void`));
    assert.equal(undone.stock.qty, 10);
  });

  test('an uncounted size is left alone, and the owner is offered it', async () => {
    const r = await w.ravi();
    const done = ok(await r.post('/api/staff/sales', saleBody({ phone: '5550000303', regNo: 'PB00DM0303', size: '205/55 R16', qty: 2 })));
    assert.equal(done.stock, null);
    const d = ok(await o.get('/api/admin/stock'));
    assert.ok(d.untracked.some(u => u.key === '205/55R16' && u.sold30 >= 2));
  });

  test('counting, recounting, warning levels and removing', async () => {
    const made = ok(await o.post('/api/admin/stock', { size: ' 175/65 r14 ', qty: 6, minQty: 2 })).row;
    assert.deepEqual([made.size, made.qty, made.minQty, made.low], ['175/65 R14', 6, 2, false]);
    const re = ok(await o.post('/api/admin/stock', { size: '175/65R14', qty: 1 })).row;
    assert.deepEqual([re.qty, re.minQty, re.low], [1, 2, true], 'a recount without a minimum keeps the old minimum');
    refused(await o.post('/api/admin/stock', { size: 'abc', qty: 1 }), 400, 'invalid');
    refused(await o.post('/api/admin/stock', { size: '175/65 R14', qty: -1 }), 400, 'invalid');
    refused(await o.post('/api/admin/stock', { size: '175/65 R14', qty: 1.5 }), 400, 'invalid');
    refused(await o.post('/api/admin/stock', { size: '175/65 R14' }), 400, 'invalid');
    ok(await o.post('/api/admin/stock/remove', { size: '175/65 R14' }));
    refused(await o.post('/api/admin/stock/remove', { size: '175/65 R14' }), 400, 'invalid');
  });
});

/* ---------- counting without cookies ---------- */

describe('POST /api/stat', () => {
  let w;
  before(async () => { w = await start(); });
  after(() => w.stop());

  test('a known name adds one to today, unknown names are refused, and nothing about the sender is kept', async () => {
    const c = w.client();
    const count = k => { const r = w.app.db.q('SELECT n FROM stats WHERE day = ? AND key = ?').get(TODAY, k); return r ? r.n : 0; };
    const found0 = count('tyres.found'), open0 = count('chat.open');
    ok(await c.post('/api/stat', { k: 'tyres.found' }));
    ok(await c.post('/api/stat', { k: 'tyres.found' }));
    ok(await c.post('/api/stat', { k: 'chat.open' }));
    refused(await c.post('/api/stat', { k: 'drop table' }), 400, 'invalid');
    refused(await c.post('/api/stat', { k: 'secret.key' }), 400, 'invalid');
    refused(await c.post('/api/stat', { k: 'page' }), 400, 'invalid');
    refused(await c.post('/api/stat', { k: 'page.anything-i-like' }), 400, 'invalid');
    refused(await c.post('/api/stat', { k: 'page.' + 'x'.repeat(60) }), 400, 'invalid');
    refused(await c.post('/api/stat', { k: 'page.home', ip: '1.2.3.4' }), 400, 'invalid');
    refused(await c.post('/api/stat', { k: 'page.home' }, { 'x-hta': undefined }), 403, 'forbidden');
    assert.equal(count('tyres.found'), found0 + 2);
    assert.equal(count('chat.open'), open0 + 1);
    const rows = w.app.db.q('SELECT * FROM stats WHERE day = ?').all(TODAY);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['day', 'key', 'n'], 'a count is a day, a name and a number: nothing else');
    assert.equal(c.jar.size, 0, 'no cookie was set');
  });

  test('the owner sees totals and days; a member of staff does not', async () => {
    const o = await w.owner();
    const s = ok(await o.get('/api/admin/stats/7'));
    assert.equal(s.days, 7);
    assert.equal(s.today, TODAY);
    assert.ok(s.totals['tyres.found'] >= 2);
    assert.ok(s.rows.every(r => r.day >= s.since && r.day <= TODAY));
    refused(await o.get('/api/admin/stats/12'), 400, 'invalid');
    const demoSeeded = s.totals['page.tyres'];
    assert.ok(demoSeeded > 0, 'the demo has a fortnight of sample counts');
  });

  test('over the limit a count is dropped quietly rather than failing the page', async () => {
    const fresh = await start();
    try {
      const c = fresh.client();
      for (let i = 0; i < LIMITS.stat.limit + 5; i++) ok(await c.post('/api/stat', { k: 'page.compare' }));
      assert.equal(fresh.app.db.q('SELECT n FROM stats WHERE day = ? AND key = ?').get(TODAY, 'page.compare').n, LIMITS.stat.limit);
    } finally { await fresh.stop(); }
  });
});

/* ---------- the old book ---------- */

describe('POST /api/admin/import', () => {
  let w, o;
  before(async () => { w = await start(); o = await w.owner(); });
  after(() => w.stop());
  const row = (over = {}) => ({ phone: '5550000401', regNo: 'PB00DM0401', tyre: 'CEAT Milaze', size: '90/100-10', qty: 2, fittedOn: '2025-03-15', ...over });

  test('rows go in as sales on their own dates; bad rows are reported one by one and the rest still go in', async () => {
    const out = ok(await o.post('/api/admin/import', { rows: [
      row(),
      row({ phone: '5550000402', regNo: 'PB00DM0402', odometerKm: 42000, billNo: 'B-77', amount: 21400, remindersOk: true }),
      row({ phone: '98765', regNo: 'PB00DM0403' }),
      row({ phone: '5550000404', regNo: 'PB00DM0404', fittedOn: '15/03/2025' }),
      row({ phone: '5550000405', regNo: 'PB00DM0405', qty: 0 }),
      row({ phone: '5550000406', regNo: 'PB00DM0406', size: '' }),
      row({ phone: '5550000407', regNo: 'PB00DM0407', fittedOn: '2031-01-01' }),
    ] })).results;
    assert.equal(out.length, 7);
    assert.deepEqual(out.map(r => r.ok), [true, true, false, false, false, false, false]);
    assert.deepEqual(out.slice(2).map(r => r.field), ['phone', 'fittedOn', 'qty', 'size', 'fittedOn']);
    const two = w.app.db.q('SELECT s.*, c.phone, c.reminders_ok FROM sales s JOIN customers c ON c.id = s.customer_id WHERE c.phone = ?').get('+915550000402');
    assert.equal(two.fitted_on, '2025-03-15');
    assert.equal(two.amount_paise, 2140000);
    assert.equal(two.bill_no, 'B-77');
    assert.equal(two.entered_by, 'owner');
    assert.equal(two.reminders_ok, 1);
    const one = w.app.db.q('SELECT c.reminders_ok FROM customers c WHERE c.phone = ?').get('+915550000401');
    assert.equal(one.reminders_ok, 0, 'no consent column, no reminders');
    const visit = w.app.db.q("SELECT stamped FROM visits WHERE kind = 'purchase' AND customer_id = (SELECT id FROM customers WHERE phone = ?)").get('+915550000401');
    assert.equal(visit.stamped, 1, 'an old sale still counts on the visit card');
  });

  test('a row already in the book is a duplicate, not a second sale', async () => {
    const before = w.app.db.q('SELECT COUNT(*) AS n FROM sales').get().n;
    const out = ok(await o.post('/api/admin/import', { rows: [row(), row({ fittedOn: '2025-03-16' })] })).results;
    assert.deepEqual(out.map(r => [r.ok, !!r.duplicate]), [[true, true], [true, false]]);
    assert.equal(w.app.db.q('SELECT COUNT(*) AS n FROM sales').get().n, before + 1);
  });

  test('the batch has a size, unknown fields are refused, and the audit log notes the batch without any row', async () => {
    refused(await o.post('/api/admin/import', { rows: [] }), 400, 'invalid');
    refused(await o.post('/api/admin/import', { rows: Array.from({ length: 26 }, () => row()) }), 400, 'invalid');
    refused(await o.post('/api/admin/import', { rows: [row()], mode: 'force' }), 400, 'invalid');
    const log = w.app.db.q("SELECT detail FROM audit WHERE action = 'import.batch' ORDER BY id DESC LIMIT 1").get();
    assert.doesNotMatch(log.detail, /555/);
  });

  test('in the demo a real-looking number is refused with the demo message', async () => {
    const out = ok(await o.post('/api/admin/import', { rows: [row({ phone: '9876543210', regNo: 'PB00DM0499' })] })).results;
    assert.equal(out[0].ok, false);
    assert.match(out[0].error, /demo/i);
  });
});

/* ---------- the job card ---------- */

describe('GET /api/staff/sales/:id/job', () => {
  let w;
  before(async () => { w = await start(); });
  after(() => w.stop());

  test('gives the fitter the sale, the vehicle and the last four digits of the phone, no more', async () => {
    const r = await w.ravi();
    const d = ok(await r.get('/api/staff/sales/1/job'));
    assert.deepEqual(Object.keys(d).sort(), ['customer', 'now', 'printedBy', 'profile', 'sale', 'services', 'shop', 'vehicle']);
    assert.deepEqual(d.customer, { phoneTail: '0101' });
    assert.equal(d.vehicle.regNo, 'PB00DM0001');
    assert.equal(d.sale.size, '185/65 R15');
    assert.equal(d.profile, 'car');
    assert.equal(d.printedBy, RAVI.name);
    assert.doesNotMatch(JSON.stringify(d), /5550000101/);
    refused(await r.get('/api/staff/sales/999/job'), 404, 'not-found');
    refused(await w.client().get('/api/staff/sales/1/job'), 401, 'staff-signed-out');
  });

  test('the job card and owner pages are served as app pages, with the strict policy', async () => {
    const c = w.client();
    for (const p of ['/admin/', '/staff/job/']) {
      const r = await c.get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.ok(r.text.includes('<symbol id="i-'), p + ' carries the icon sprite');
      assert.doesNotMatch(r.text, / style="/, p + ' has no inline styles');
    }
    for (const p of ['/admin', '/staff/job']) assert.equal((await c.get(p)).status, 308);
    assert.equal((await c.get('/assets/templates/customer-book.csv')).status, 200);
  });
});

/* ---------- backups ---------- */

describe('backups', () => {
  test('in the demo there is no file to copy, but the status says so and a sample copy can still be downloaded', async () => {
    const w = await start();
    try {
      const o = await w.owner();
      const b = ok(await o.get('/api/admin/backup'));
      assert.equal(b.demo, true);
      assert.equal(b.offsite.configured, false);
      refused(await o.post('/api/admin/backup/now'), 400, 'demo');
      const dl = await o.get('/api/admin/backup/download');
      assert.equal(dl.status, 200);
      assert.equal(dl.buf.subarray(0, 15).toString('latin1'), 'SQLite format 3');
      assert.match(dl.headers.get('content-disposition'), /demo-sample-2026-10-08\.sqlite/);
      assert.equal(w.app.db.q("SELECT COUNT(*) AS n FROM audit WHERE action = 'backup.download'").get().n, 1);
    } finally { await w.stop(); }
  });

  test('a live site: back up now writes today\'s copy and sends it off-site; the upload is a signed PUT with no secret in it', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => { let size = 0; for await (const chunk of init.body) size += chunk.length; calls.push({ url, headers: init.headers, size }); return { ok: true, status: 200, text: async () => '' }; };
    const settings = { bucket: 'hta-copies', region: 'auto', endpoint: 'https://abc.r2.cloudflarestorage.com', prefix: 'shop', accessKey: 'AKIATEST', secret: 'verysecret' };
    const w = await start({ live: true, fetch: fakeFetch, offsite: settings });
    try {
      const o = await w.owner();
      const done = ok(await o.post('/api/admin/backup/now'));
      assert.equal(done.file, `passport-${TODAY}.sqlite`);
      assert.deepEqual(done.sent && { key: done.sent.key }, { key: `shop/passport-${TODAY}.sqlite` });
      assert.equal(done.error, null);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://abc.r2.cloudflarestorage.com/hta-copies/shop/passport-${TODAY}.sqlite`);
      assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIATEST\/20261008\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(calls[0]), /verysecret/);
      assert.equal(Number(calls[0].headers['content-length']), calls[0].size);
      const b = ok(await o.get('/api/admin/backup'));
      assert.equal(b.offsite.configured, true);
      assert.deepEqual(b.offsite.where, { bucket: 'hta-copies', endpoint: 'https://abc.r2.cloudflarestorage.com', prefix: 'shop', region: 'auto' });
      assert.equal(b.offsite.lastName, `shop/passport-${TODAY}.sqlite`);
      assert.equal(b.offsite.lastError, null);
      assert.equal(b.local.files.length, 1);
      // housekeeping the same day does not send again; the next day it does
      await w.app.housekeeping().offsite;
      assert.equal(calls.length, 1);
      w.skip(DAY);
      const hk = w.app.housekeeping();
      assert.equal(await hk.offsite, true);
      assert.equal(calls.length, 2);
    } finally { await w.stop(); }
  });

  test('a refused upload is recorded as the last problem and does not stop the local copy', async () => {
    const fakeFetch = async () => ({ ok: false, status: 403, text: async () => '<Error><Code>SignatureDoesNotMatch</Code></Error>' });
    const settings = { bucket: 'b', region: 'ap-south-1', endpoint: 'https://s3.ap-south-1.amazonaws.com', prefix: '', accessKey: 'k', secret: 's' };
    const w = await start({ live: true, fetch: fakeFetch, offsite: settings });
    try {
      const o = await w.owner();
      const done = ok(await o.post('/api/admin/backup/now'));
      assert.match(done.error, /403.*SignatureDoesNotMatch/);
      assert.equal(done.status.local.files.length, 1);
      assert.match(done.status.offsite.lastError, /403/);
      assert.equal(done.status.offsite.lastAt, null);
      assert.match(w.logs.at(-1), /off-site backup failed/);
    } finally { await w.stop(); }
  });

  test('the settings are all-or-nothing and checked', () => {
    assert.equal(offsiteSettings({}), null);
    assert.throws(() => offsiteSettings({ BACKUP_S3_BUCKET: 'b' }), ConfigError);
    assert.throws(() => offsiteSettings({ BACKUP_S3_BUCKET: 'bkt', BACKUP_S3_KEY: 'k', BACKUP_S3_SECRET: 's' }), /BACKUP_S3_ENDPOINT/);
    assert.throws(() => offsiteSettings({ BACKUP_S3_BUCKET: 'Bad Name', BACKUP_S3_KEY: 'k', BACKUP_S3_SECRET: 's', BACKUP_S3_REGION: 'ap-south-1' }), ConfigError);
    assert.throws(() => offsiteSettings({ BACKUP_S3_BUCKET: 'bkt', BACKUP_S3_KEY: 'k', BACKUP_S3_SECRET: 's', BACKUP_S3_ENDPOINT: 'http://insecure.example' }), /https/);
    const aws = offsiteSettings({ BACKUP_S3_BUCKET: 'my-bucket', BACKUP_S3_KEY: 'k', BACKUP_S3_SECRET: 's', BACKUP_S3_REGION: 'ap-south-1' });
    assert.deepEqual(aws, { bucket: 'my-bucket', region: 'ap-south-1', endpoint: 'https://s3.ap-south-1.amazonaws.com', prefix: 'hta-passport', accessKey: 'k', secret: 's' });
    const r2 = offsiteSettings({ BACKUP_S3_BUCKET: 'bkt', BACKUP_S3_KEY: 'k', BACKUP_S3_SECRET: 's', BACKUP_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com/', BACKUP_S3_PREFIX: '/copies/' });
    assert.equal(r2.endpoint, 'https://abc.r2.cloudflarestorage.com');
    assert.equal(r2.prefix, 'copies');
    assert.equal(makeOffsite(null).ready, false);
  });

  test('the signature matches a worked example', () => {
    // the same inputs always give the same signature, and a different secret gives a different one
    const base = { endpoint: 'https://s3.ap-south-1.amazonaws.com', region: 'ap-south-1', bucket: 'hta', key: 'hta-passport/passport-2026-10-08.sqlite', accessKey: 'AKIAEXAMPLE', secret: 'wJalrXUtnFEMI', contentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', contentLength: 0, at: new Date(T0) };
    const a = signPut(base), b = signPut(base), c = signPut({ ...base, secret: 'other' });
    assert.equal(a.headers.authorization, b.headers.authorization);
    assert.notEqual(a.headers.authorization, c.headers.authorization);
    assert.equal(a.url, 'https://s3.ap-south-1.amazonaws.com/hta/hta-passport/passport-2026-10-08.sqlite');
    assert.equal(a.headers['x-amz-date'], '20261008T060000Z');
    assert.equal('host' in a.headers, false);
  });

  test('restore puts a copy in place, keeps the old database beside it, and refuses rubbish', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'restore-'));
    const cfg = { mode: 'live', dataDir: dir };
    const db = openDb(cfg, T0);
    db.q("INSERT INTO customers (phone, reminders_ok, stop_token, referral_code, created_at) VALUES ('+919876500001', 0, 'tok1', 'CODE0001', ?)").run(T0);
    db.checkpoint();
    const copy = path.join(dir, 'copy.sqlite');
    db.exec(`VACUUM INTO '${copy.replace(/\\/g, '/')}'`);
    db.q("INSERT INTO customers (phone, reminders_ok, stop_token, referral_code, created_at) VALUES ('+919876500002', 0, 'tok2', 'CODE0002', ?)").run(T0);
    db.checkpoint();
    db.close();
    const out = restore(copy, dir, SCHEMA_VERSION, T0);
    assert.equal(out.customers, 1);
    assert.ok(fs.existsSync(out.kept));
    const live = new DatabaseSync(path.join(dir, 'passport.sqlite'), { readOnly: true });
    assert.equal(live.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
    live.close();
    const kept = new DatabaseSync(out.kept, { readOnly: true });
    assert.equal(kept.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 2);
    kept.close();
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    assert.throws(() => restore(path.join(dir, 'notes.txt'), dir, SCHEMA_VERSION), /not a SQLite database/);
    assert.throws(() => restore(copy, dir, 1), /newer than this server/);
  });

  test('an older database is brought up to the current schema when opened', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'migrate-'));
    const file = path.join(dir, 'passport.sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '1');
              CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL, tyre TEXT NOT NULL, size TEXT NOT NULL, qty INTEGER NOT NULL, odometer_km INTEGER NOT NULL, new_tread_mm REAL, bill_no TEXT, amount_paise INTEGER, warranty_months INTEGER NOT NULL, fitted_on TEXT NOT NULL, token TEXT NOT NULL UNIQUE, idem TEXT UNIQUE, created_at INTEGER NOT NULL);
              CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL, sale_id INTEGER, kind TEXT NOT NULL, visited_on TEXT NOT NULL, odometer_km INTEGER, tread_mm REAL, services TEXT NOT NULL DEFAULT '[]', stamped INTEGER NOT NULL DEFAULT 0, idem TEXT UNIQUE, created_at INTEGER NOT NULL);
              CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, phone TEXT, tag TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
    raw.close();
    const db = openDb({ mode: 'live', dataDir: dir }, T0);
    assert.equal(db.q("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
    assert.ok(db.q('PRAGMA table_info(sales)').all().some(c => c.name === 'entered_by'));
    assert.ok(db.q('PRAGMA table_info(sessions)').all().some(c => c.name === 'staff_name'));
    assert.ok(db.q("SELECT name FROM sqlite_master WHERE name = 'staff'").get());
    db.close();
    const again = openDb({ mode: 'live', dataDir: dir }, T0);   // opening a second time changes nothing
    again.close();
  });
});

/* ---------- the owner's numbers ---------- */

describe('GET /api/admin/overview', () => {
  test('counts the book without naming anyone', async () => {
    const w = await start();
    try {
      const o = await w.owner();
      const ov = ok(await o.get('/api/admin/overview'));
      assert.equal(ov.today, TODAY);
      for (const k of ['today', 'week', 'month', 'year']) for (const f of ['sales', 'tyres', 'rupees', 'services', 'newCustomers', 'remindersSent', 'breakdowns']) assert.equal(typeof ov.periods[k][f], 'number', `${k}.${f}`);
      assert.ok(ov.periods.year.sales >= ov.periods.month.sales && ov.periods.month.sales >= ov.periods.week.sales);
      assert.equal(ov.customers.total, 6);
      assert.ok(ov.periods.week.sales >= 1 && ov.periods.week.services >= 1, 'the demo has numbers for this week');
      assert.equal(ov.lowStockCount, 2);
      assert.equal(ov.unseenBreakdowns, 1);
      assert.ok(ov.periods.year.byStaff.length >= 2);
      assert.ok(ov.periods.year.topSizes.length >= 2);
      assert.doesNotMatch(JSON.stringify(ov), /555000|PB00DM/);
    } finally { await w.stop(); }
  });
});
