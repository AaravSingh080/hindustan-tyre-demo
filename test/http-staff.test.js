'use strict';

/* HTTP-level tests for the staff side of the tyre passport, and for the files the server hands out.

   Every test talks to a real http server on a random port, through the same routes the staff page uses.
   Time never comes from the wall clock: each app gets an injected clock that the test moves by hand.
   Most tests start their own app, so no test depends on what another one left behind.

   Live-mode tests keep their database in a fresh folder under the system temp folder. Those folders are left
   in place on purpose (nothing here deletes files). */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/app');
const { qrSvg } = require('../server/qr');

const ROOT = path.resolve(__dirname, '..');
const SEC = 1e3, MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const HANG_MS = 15000;                               // real time: how long a request may go unanswered before the test fails
const T0 = Date.UTC(2026, 9, 6, 6, 0, 0);            // 6 Oct 2026, 11:30 in India
const TODAY = '2026-10-06';
const LIVE_PIN = '48151623', NEW_PIN = '73920461', WRONG_PIN = '10293847';
// how many wrong PINs the server allows before it locks: from one address and from all addresses together inside
// fifteen minutes, and from every browser the shop has not used inside a day
const PIN_TRIES = 5, PIN_TRIES_ALL = 20, PIN_TRIES_DAY = 60;
const untilLocked = tries => [...Array(tries - 1).fill(401), 429];

/* The shop settings these tests run on. They mirror config/passport.json as shipped, but are pinned here so an
   owner editing that file (a different reward, another service interval) does not change what is tested.
   Two shops, so "the nearest shop" means something. */
const SETTINGS = {
  shop: { name: 'Test Tyre House', whatsapp: '918300000001', utcOffsetMinutes: 330 },
  shops: [
    { id: 'ludhiana', name: 'Test Tyre House, Ludhiana', phone: '+918300000001', address: 'Station Road, Ludhiana', lat: 30.9122, lng: 75.8483 },
    { id: 'jalandhar', name: 'Test Tyre House, Jalandhar', phone: '+918300000002', address: 'GT Road, Jalandhar', lat: 31.326, lng: 75.5762 },
  ],
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
  warranty: { defaultMonths: 60, policyUrl: 'https://example.test/warranty' },
  privacy: { deleteAfterInactiveYears: 7, noticeVersion: 'test-1' },
};

/* ---------- helpers ---------- */

// No key is set, so this is demo mode. DATA_DIR points at a folder that is never created: it only keeps a
// developer's own local database under ./data from getting in the way of the demo's start-up check.
const DEMO_ENV = { DATA_DIR: path.join(os.tmpdir(), 'hta-http-staff-demo-never-created') };

// one folder per run of this file, with one sub-folder per live database
let runDir = null;
const tmpDataDir = () => {
  if (!runDir) runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-http-staff-'));
  return fs.mkdtempSync(path.join(runDir, 'db-'));
};
const liveEnv = (dir, extra = {}) => ({
  APP_SECRET: 'x'.repeat(40), STAFF_PIN: LIVE_PIN, PUBLIC_BASE_URL: 'http://localhost:1', DATA_DIR: dir,
  MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't', ...extra,
});
function fakeSms() {
  const sent = [];
  return { ready: true, sent, async sendOtp(phone, code) { sent.push({ phone, code }); return { ok: true }; } };
}

// a browser: remembers cookies, and sends what the site's own pages send on a request that changes something
function makeClient(base) {
  const jar = new Map();
  async function request(method, pathname, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size && !('cookie' in h)) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (method !== 'GET' && method !== 'HEAD') {
      if (!('content-type' in h)) h['content-type'] = 'application/json';
      if (!('x-hta' in h)) h['x-hta'] = '1';
      payload = typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body);
    }
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];   // null: leave this header out
    // the time limit only turns a server that never answers into a failed test instead of a stuck one
    const res = await fetch(base + pathname, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(HANG_MS) });
    const setCookie = res.headers.getSetCookie();
    for (const line of setCookie) {
      const pair = line.split(';')[0], i = pair.indexOf('=');
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      if (value === '' || /;\s*max-age=0\b/i.test(line)) jar.delete(name); else jar.set(name, value);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null;
    if ((res.headers.get('content-type') || '').startsWith('application/json')) { try { json = JSON.parse(text); } catch { /* left as null */ } }
    return { status: res.status, headers: res.headers, setCookie, buf, text, json };
  }
  return {
    jar,
    request,
    get: (p, headers) => request('GET', p, { headers }),
    head: (p, headers) => request('HEAD', p, { headers }),
    post: (p, body, headers) => request('POST', p, { body, headers }),
  };
}

// fetch tidies a path before sending it ("/css/../x" becomes "/x") and will not send a made-up Host header.
// This sends the path and the headers exactly as written.
function raw(base, method, rawPath, headers = {}, body) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: rawPath, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(HANG_MS, () => req.destroy(new Error(`no answer to ${method} ${rawPath}`)));
    req.on('error', reject);
    req.end(body);
  });
}

/* Starts an app and a server on a free port. opts: { env, clock, sms, shipped, tweak }.
   clock is { ms }, shared between apps when a test restarts the server on the same database.
   shipped: true reads config/passport.json as the owner has it, instead of the pinned SETTINGS above.
   tweak: a function that edits this app's own copy of SETTINGS, as an owner editing the file would. */
async function boot(t, { env = DEMO_ENV, clock = { ms: T0 }, sms, shipped = false, tweak } = {}) {
  const options = { env, now: () => clock.ms, jitter: false };
  if (!shipped) options.settings = structuredClone(SETTINGS);
  if (tweak) tweak(options.settings);
  if (sms) options.sms = sms;
  const app = createApp(options);
  const server = http.createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    app.close();
  };
  if (t) t.after(close);

  const ctx = { app, base, clock, sms, close, now: () => clock.ms, tick: ms => { clock.ms += ms; }, client: () => makeClient(base) };
  // a staff browser, signed in with the current PIN
  ctx.staff = async headers => {
    const c = ctx.client();
    ok(await c.post('/api/staff/login', { pin: app.cfg.staffPin }, headers), 'staff sign-in');
    return c;
  };
  // a customer's phone, signed in with a code and the last four characters of the plate
  ctx.customer = async (phone, plate) => {
    const c = ctx.client();
    const asked = ok(await c.post('/api/auth/request', { phone }), 'asking for a code');
    const code = app.cfg.mode === 'demo' ? asked.demo.code : sms.sent[sms.sent.length - 1].code;
    ok(await c.post('/api/auth/verify', { phone, code, plate }), 'customer sign-in');
    return c;
  };
  return ctx;
}

function ok(res, what = 'the request') {
  assert.equal(res.status, 200, `${what} should succeed, but got ${res.status}: ${res.text.slice(0, 300)}`);
  return res.json;
}
function refused(res, status, code) {
  assert.equal(res.status, status, `expected ${status} ${code || ''}, got ${res.status}: ${res.text.slice(0, 300)}`);
  assert.ok(res.json && res.json.error, 'a refusal is a JSON error');
  if (code) assert.equal(res.json.error.code, code);
  return res.json.error;
}

const signIn = (client, pin, headers) => client.post('/api/staff/login', { pin }, headers);
// the search goes in the body of a POST: a phone or vehicle number must never be part of an address
const lookup = (staff, q) => staff.post('/api/staff/lookup', { q });
const find = async (staff, q) => ok(await lookup(staff, q), `lookup ${q}`).results;
const saleBody = (over = {}) => ({ phone: '5550000199', regNo: 'PB00TS0199', tyre: 'MRF ZLX', size: '165/80 R14', qty: 4, odometerKm: 12000, ...over });
// a calendar day so many days after (or, with a minus, before) another
const dayPlus = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

const keysDeep = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};

// names of the database tables that still hold this text anywhere
function tablesMentioning(db, needle) {
  const tables = db.q("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  return tables.filter(name => db.q(`SELECT * FROM "${name}"`).all().some(row => JSON.stringify(row).includes(needle)));
}

/* ---------- who may use the staff routes ---------- */

// Every staff route except the sign-in itself. Each entry is a request that succeeds for signed-in staff on the
// demo data when sent in this order (a test below proves it), so a 401 here is about who is asking, not what.
const STAFF_ROUTES = [
  ['GET', '/api/staff/status'],
  ['POST', '/api/staff/lookup', { q: 'PB00' }],
  ['GET', '/api/staff/customers/1'],
  ['GET', '/api/staff/due'],
  ['GET', '/api/staff/breakdowns'],
  ['GET', '/api/staff/qr'],
  ['GET', '/api/staff/qr?sale=1'],
  ['GET', '/api/staff/sales/1/job'],
  ['POST', '/api/staff/reminders', { key: 'rep:1:1', status: 'marked_sent' }],
  ['POST', '/api/staff/sales', saleBody()],
  ['POST', '/api/staff/sales/6/void'],
  ['POST', '/api/staff/visits', { vehicleId: 1, odometerKm: 52000 }],
  ['POST', '/api/staff/customers/1/reminders', { on: false }],
  ['POST', '/api/staff/grants/3/use'],
  ['POST', '/api/staff/grants/3/unuse'],
  ['POST', '/api/staff/vehicles/1', { regNo: 'PB00XX0001' }],
  ['POST', '/api/staff/breakdowns/1/seen'],
  ['POST', '/api/staff/customers/1/delete', { last4: '0101' }],
  ['POST', '/api/staff/logout'],
];
const send = (client, [method, p, body]) => (method === 'GET' ? client.get(p) : client.post(p, body));

// what staff can see of the demo data; taken before and after an attack to show nothing moved
async function snapshot(ctx) {
  const s = await ctx.staff();
  return {
    customers: ok(await s.get('/api/staff/status')).database.customers,
    everyone: await find(s, 'PB00'),
    first: ok(await s.get('/api/staff/customers/1')).customer,
    due: ok(await s.get('/api/staff/due')).items,
    breakdowns: ok(await s.get('/api/staff/breakdowns')).items,
  };
}

describe('staff routes are closed to everyone but signed-in staff', () => {
  test('every staff route answers 401 to a visitor who has not signed in, and changes nothing', async t => {
    const ctx = await boot(t);
    const before = await snapshot(ctx);
    const visitor = ctx.client();
    for (const r of STAFF_ROUTES) {
      const res = await send(visitor, r);
      assert.equal(res.status, 401, `${r[0]} ${r[1]} without a staff session`);
      assert.equal(res.json.error.code, 'staff-signed-out');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(res.setCookie, []);
    }
    assert.deepEqual(await snapshot(ctx), before);
  });

  test('the same requests all succeed for signed-in staff', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    for (const r of STAFF_ROUTES) ok(await send(s, r), `${r[0]} ${r[1]} as staff`);
  });

  test('the list of routes checked above covers every staff route the server defines', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
    const defined = [...source.matchAll(/route\(\s*'([A-Z]+)'\s*,\s*'(\/api\/staff\/[^']*)'/g)].map(m => `${m[1]} ${m[2]}`).filter(r => r !== 'POST /api/staff/login');
    assert.ok(defined.length >= 15, `expected to find the staff routes in server/app.js, found ${defined.length}`);
    const covered = new Set(STAFF_ROUTES.map(([method, p]) => `${method} ${p.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id')}`));
    for (const r of defined) assert.ok(covered.has(r), `${r} is a staff route with no 401 check in this file`);
  });

  test('a signed-in customer is not staff, even with their own session token copied into the staff cookies', async t => {
    const ctx = await boot(t);
    const customer = await ctx.customer('5550000101', '0001');
    const token = customer.jar.get('hta_c');
    assert.ok(token, 'the customer holds a session cookie');
    const before = await snapshot(ctx);

    for (const r of STAFF_ROUTES) refused(await send(customer, r), 401, 'staff-signed-out');
    const forged = ctx.client();
    for (const name of ['hta_c', 'hta_s', 'hta_d']) forged.jar.set(name, token);
    for (const r of STAFF_ROUTES) refused(await send(forged, r), 401, 'staff-signed-out');

    const guess = ctx.client();
    guess.jar.set('hta_s', 'A'.repeat(43));
    refused(await guess.get('/api/staff/status'), 401, 'staff-signed-out');
    assert.deepEqual(await snapshot(ctx), before);
  });

  test('another site cannot make a signed-in staff browser change anything', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const target = '/api/staff/customers/1/reminders';
    const state = async () => ok(await s.get('/api/staff/customers/1')).customer.reminders.state;
    assert.equal(await state(), 'yes');

    const attempts = [
      ['a plain HTML form', { 'content-type': 'application/x-www-form-urlencoded', 'x-hta': null }],
      ['a text/plain post', { 'content-type': 'text/plain' }],
      ['JSON without the site header', { 'x-hta': null }],
      ['a page on another origin', { origin: 'https://evil.example' }],
      ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
      ['a sibling site', { 'sec-fetch-site': 'same-site' }],
    ];
    for (const [what, headers] of attempts) {
      const res = await s.post(target, { on: false }, headers);
      refused(res, 403, 'forbidden');
      assert.equal(res.headers.get('access-control-allow-origin'), null, `${what}: no cross-origin reading either`);
    }
    assert.equal(await state(), 'yes', 'none of the refused requests changed the customer');

    // what a browser on the site's own page sends is accepted
    ok(await s.post(target, { on: false }, { origin: ctx.base, 'sec-fetch-site': 'same-origin' }));
    assert.equal(await state(), 'stopped');
  });

  test('signing out ends the session on the server, not only in the browser', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const token = s.jar.get('hta_s');
    ok(await s.get('/api/staff/status'));

    const out = await s.post('/api/staff/logout');
    ok(out);
    assert.ok(out.setCookie.some(c => /^hta_s=;/.test(c) && /max-age=0/i.test(c)), 'the browser is told to drop the cookie');
    const replay = ctx.client();
    replay.jar.set('hta_s', token);
    refused(await replay.get('/api/staff/status'), 401, 'staff-signed-out');
  });

  test('an address that hammers the API is slowed down for a minute, without blocking the signed-in counter tablet or the site', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const visitor = ctx.client();
    let allowed = 0, slowed = null;
    for (let i = 0; i < 200 && !slowed; i++) {
      const res = await visitor.get('/api/staff/status');
      if (res.status === 429) slowed = res;
      else { assert.equal(res.status, 401); allowed++; }
    }
    assert.ok(slowed, 'after enough requests in one minute the answer is 429');
    assert.ok(allowed >= 50, `an ordinary visitor is not slowed down after only ${allowed} requests`);
    assert.equal(slowed.json.error.code, 'slow-down');
    const wait = Number(slowed.headers.get('retry-after'));
    assert.ok(wait >= 1 && wait <= 60, `Retry-After should be within the minute, got ${slowed.headers.get('retry-after')}`);

    ok(await s.get('/api/staff/status'), 'signed-in staff on the same address');
    assert.equal((await visitor.get('/')).status, 200, 'the site itself is not rate limited');

    ctx.tick(61 * SEC);
    refused(await visitor.get('/api/staff/status'), 401, 'staff-signed-out');
  });
});

/* ---------- the staff PIN ---------- */

describe('staff sign-in with the PIN', () => {
  test('wrong PINs count down the tries left, then lock; the right PIN is refused during the lock and works after it', async t => {
    const ctx = await boot(t);
    const pin = ctx.app.cfg.staffPin;
    const stranger = ctx.client();

    const left = [];
    for (let i = 0; i < PIN_TRIES - 1; i++) {
      // a made-up X-Forwarded-For on each try: with no proxy configured it must not buy a fresh allowance
      const res = await signIn(stranger, WRONG_PIN, { 'x-forwarded-for': `203.0.113.${i + 1}` });
      const e = refused(res, 401, 'wrong-pin');
      left.push(e.left);
      assert.ok(e.message.includes(String(e.left)), 'the message says how many tries are left');
      assert.deepEqual(res.setCookie, []);
    }
    assert.deepEqual(left, Array.from({ length: PIN_TRIES - 1 }, (_, i) => PIN_TRIES - 1 - i), 'tries left, counting down to 1');

    const last = await signIn(stranger, WRONG_PIN, { 'x-forwarded-for': '203.0.113.99' });
    refused(last, 429, 'locked');
    const lockSec = Number(last.headers.get('retry-after'));
    assert.ok(lockSec >= 5 * 60, `the lock lasts long enough to matter, got Retry-After ${last.headers.get('retry-after')}`);

    const during = await signIn(stranger, pin);
    refused(during, 429, 'locked');
    assert.deepEqual(during.setCookie, [], 'no session is handed out during the lock');
    refused(await stranger.get('/api/staff/status'), 401, 'staff-signed-out');

    ctx.tick(lockSec * SEC - MIN);
    const nearly = await signIn(stranger, pin);
    refused(nearly, 429, 'locked');
    assert.equal(nearly.headers.get('retry-after'), '60', 'a minute before the end, one minute is left');

    ctx.tick(MIN + SEC);
    const opened = ok(await signIn(stranger, pin), 'the right PIN once the lock has run out');
    assert.equal(opened.wrongSince, PIN_TRIES, 'staff are told how many wrong tries there were since the last sign-in');
    ok(await stranger.get('/api/staff/status'));
    assert.equal(ok(await signIn(stranger, pin)).wrongSince, 0);
  });

  test('a second run of wrong PINs is locked out for longer than the first', async t => {
    const ctx = await boot(t);
    const stranger = ctx.client();
    const run = async () => {
      let last;
      for (let i = 0; i < PIN_TRIES; i++) last = await signIn(stranger, WRONG_PIN);
      refused(last, 429, 'locked');
      return Number(last.headers.get('retry-after'));
    };
    const first = await run();
    ctx.tick(first * SEC + SEC);
    const second = await run();
    assert.ok(second > first, `first lock ${first}s, second lock ${second}s`);
  });

  test('a browser that has signed in before is not locked out by wrong PINs typed somewhere else', async t => {
    const ctx = await boot(t);
    const pin = ctx.app.cfg.staffPin;
    const shop = await ctx.staff();
    const remembered = shop.jar.get('hta_d');
    assert.ok(remembered, 'a good sign-in leaves a device cookie');

    // the shop tablet the next morning: signed out, but still holding the device cookie
    const tablet = ctx.client();
    tablet.jar.set('hta_d', remembered);

    const stranger = ctx.client();
    const statuses = [];
    for (let i = 0; i < PIN_TRIES; i++) statuses.push((await signIn(stranger, WRONG_PIN)).status);
    assert.deepEqual(statuses, untilLocked(PIN_TRIES));
    refused(await signIn(stranger, pin), 429, 'locked');
    refused(await signIn(ctx.client(), pin), 429, 'locked');           // same address, no device cookie

    ok(await signIn(tablet, pin), 'the remembered browser signs in during the lock');
    ok(await tablet.get('/api/staff/status'));
    refused(await signIn(ctx.client(), pin), 429, 'locked');           // and that did not lift the lock for anyone else

    // the remembered browser has its own count of wrong tries, starting fresh
    assert.equal(refused(await signIn(tablet, WRONG_PIN), 401, 'wrong-pin').left, PIN_TRIES - 1);
  });

  test('the staff cookies cannot be read by scripts or sent from other sites, and the session lasts twelve hours', async t => {
    const ctx = await boot(t);
    const res = await signIn(ctx.client(), ctx.app.cfg.staffPin);
    ok(res);
    for (const name of ['hta_s', 'hta_d']) {
      const line = res.setCookie.find(c => c.startsWith(name + '='));
      assert.ok(line, `${name} is set`);
      assert.match(line, /;\s*HttpOnly/i);
      assert.match(line, /;\s*SameSite=Strict/i);
      assert.match(line, /;\s*Path=\/(;|$)/i);
      assert.ok(!res.text.includes(line.split(';')[0].split('=')[1]), 'the token is not in the response body');
    }
    assert.match(res.setCookie.find(c => c.startsWith('hta_s=')), /;\s*Max-Age=43200(;|$)/i);
  });

  test('a PIN that is not digits is refused without using up a try', async t => {
    const ctx = await boot(t);
    const stranger = ctx.client();
    for (const pin of ['', 'abcdef', 246810, "246810' OR '1'='1", '1'.repeat(13)]) refused(await signIn(stranger, pin), 400, 'invalid');
    assert.equal(refused(await signIn(stranger, WRONG_PIN), 401, 'wrong-pin').left, PIN_TRIES - 1);
  });

  /* A patient guesser: four wrong PINs, then a wait until the fifteen-minute counters have run out, and again.
     That never trips the lock for one address (five tries) or for the whole site (twenty). Returns the answers. */
  async function slowWrongTries(ctx, client, count) {
    const answers = [];
    for (let n = 0; n < count; n++) {
      if (n > 0 && n % (PIN_TRIES - 1) === 0) ctx.tick(16 * MIN);
      answers.push(await signIn(client, WRONG_PIN));
    }
    return answers;
  }

  test('a slow guesser who stays under the fifteen-minute limits is stopped by the count for the day: 60 wrong PINs in 24 hours lock out every browser the shop has not used, for 12 hours', async t => {
    const ctx = await boot(t);
    const pin = ctx.app.cfg.staffPin;
    const shop = await ctx.staff();                       // the shop tablet signed in before the guessing began
    const tablet = ctx.client();
    tablet.jar.set('hta_d', shop.jar.get('hta_d'));

    const guesser = ctx.client();
    const answers = await slowWrongTries(ctx, guesser, PIN_TRIES_DAY);
    assert.deepEqual(answers.slice(0, -1).map(r => r.status), Array(PIN_TRIES_DAY - 1).fill(401), 'no short limit was reached on the way');
    assert.ok(answers.slice(0, -1).every(r => r.json.error.code === 'wrong-pin'));
    assert.equal(answers[PIN_TRIES_DAY - 2].json.error.left, 1, 'before the last try the guesser is told one is left');
    const last = answers[PIN_TRIES_DAY - 1];
    refused(last, 429, 'locked');
    assert.equal(last.headers.get('retry-after'), String(12 * 3600), 'twelve hours');

    // the right PIN is no use to the guesser now, nor to any other browser the shop has not used
    refused(await signIn(guesser, pin), 429, 'locked');
    refused(await signIn(ctx.client(), pin), 429, 'locked');
    ok(await signIn(tablet, pin), 'the shop\'s own tablet is not locked out');

    // the short locks last four hours at most; this one is still there after that
    ctx.tick(4 * HOUR + MIN);
    refused(await signIn(ctx.client(), pin), 429, 'locked');
    ctx.tick(8 * HOUR - 2 * MIN);                         // a minute short of twelve hours
    const nearly = await signIn(ctx.client(), pin);
    refused(nearly, 429, 'locked');
    assert.equal(nearly.headers.get('retry-after'), '60');
    ctx.tick(MIN + SEC);
    ok(await signIn(ctx.client(), pin), 'after twelve hours a browser the shop has not used can sign in again');
  });

  test('the day count covers 24 hours and only browsers the shop has not used: wrong PINs on a remembered tablet, or more than a day apart, do not add up', async t => {
    const ctx = await boot(t);
    const pin = ctx.app.cfg.staffPin;
    const shop = await ctx.staff();
    const tablet = ctx.client();
    tablet.jar.set('hta_d', shop.jar.get('hta_d'));
    const startedAt = ctx.now();

    // two short of the day's limit
    const guesser = ctx.client();
    const answers = await slowWrongTries(ctx, guesser, PIN_TRIES_DAY - 2);
    assert.deepEqual(answers.map(r => r.status), Array(PIN_TRIES_DAY - 2).fill(401));
    assert.equal(answers[answers.length - 1].json.error.left, 2);

    // staff fumble the PIN on the shop tablet: that goes on the tablet's own count, not the day's
    const fumbles = [];
    for (let i = 0; i < PIN_TRIES - 1; i++) fumbles.push(refused(await signIn(tablet, WRONG_PIN), 401, 'wrong-pin').left);
    assert.deepEqual(fumbles, [4, 3, 2, 1]);
    ok(await signIn(tablet, pin));
    assert.equal(refused(await signIn(guesser, WRONG_PIN), 401, 'wrong-pin').left, 1, 'the guesser\'s 59th wrong try is still only the 59th');

    // a day after the first wrong try the count starts again: this would otherwise be the 60th
    ctx.tick(startedAt + 24 * HOUR + MIN - ctx.now());
    assert.equal(refused(await signIn(guesser, WRONG_PIN), 401, 'wrong-pin').left, PIN_TRIES - 1);
    ok(await signIn(ctx.client(), pin), 'and nobody is locked out');
  });
});

describe('how long a staff sign-in lasts', () => {
  test('it ends after 30 minutes without use', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(29 * MIN);
    ok(await s.get('/api/staff/status'), 'used again after 29 minutes');
    ctx.tick(31 * MIN);
    refused(await s.get('/api/staff/status'), 401, 'staff-signed-out');
    refused(await s.post('/api/staff/customers/1/reminders', { on: false }), 401, 'staff-signed-out');
    refused(await s.get('/api/staff/status'), 401, 'staff-signed-out');    // and it does not come back
    const fresh = await ctx.staff();
    assert.equal(ok(await fresh.get('/api/staff/customers/1')).customer.reminders.state, 'yes', 'the expired session changed nothing');
  });

  test('it ends 12 hours after signing in, however busy the counter is', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    for (let i = 0; i < 35; i++) {                       // used every 20 minutes for 11 hours 40 minutes
      ctx.tick(20 * MIN);
      ok(await s.get('/api/staff/status'), `request ${i + 1}`);
    }
    ctx.tick(21 * MIN);                                  // 12 hours and a minute; only 21 minutes since the last use
    refused(await s.get('/api/staff/status'), 401, 'staff-signed-out');
  });

  test('background checks marked x-hta-passive do not keep an unattended session alive', async t => {
    const ctx = await boot(t);
    const unattended = await ctx.staff();                // a tablet left on the desk: only its timer talks to the server
    const working = await ctx.staff();                   // someone is using this one
    const passive = { 'x-hta-passive': '1' };
    for (const minutes of [10, 10, 9]) {
      ctx.tick(minutes * MIN);
      ok(await unattended.get('/api/staff/status', passive));
      ok(await unattended.get('/api/staff/due', passive));
      ok(await working.get('/api/staff/status'));
    }
    ctx.tick(2 * MIN);                                   // 31 minutes after signing in
    refused(await unattended.get('/api/staff/status', passive), 401, 'staff-signed-out');
    refused(await unattended.get('/api/staff/status'), 401, 'staff-signed-out');
    ok(await working.get('/api/staff/status'));
  });
});

/* ---------- the work staff do ---------- */

describe('staff work at the counter', () => {
  test('a sale registered by staff reads back for staff and for the customer, with the amount kept in paise and no link token for the customer', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    // Rs 18,650.35: in floating point 18650.35 * 100 is 1865034.9999999998, so a server that cut instead of rounding would lose a paisa
    const body = saleBody({ phone: '55500 00199', regNo: 'pb 00 ts 0199', size: '165/80 r14', amount: 18650.35, billNo: 'ht/2026/0199', remindersOk: true, idem: 'sale-0199-first-try' });
    const done = ok(await s.post('/api/staff/sales', body));
    assert.equal(done.duplicate, false);
    assert.equal(done.consent, 'yes');
    assert.ok(done.passportUrl.startsWith(`${ctx.base}/passport/#s=`), done.passportUrl);
    const token = done.passportUrl.split('#s=')[1];
    assert.match(token, /^[A-Za-z0-9_-]{16,}$/);

    const expectSale = current => {
      assert.equal(current.tyre, 'MRF ZLX');
      assert.equal(current.size, '165/80 R14');
      assert.equal(current.qty, 4);
      assert.equal(current.odometerKm, 12000);
      assert.equal(current.billNo, 'HT/2026/0199');
      assert.equal(current.fittedOn, TODAY);
      assert.equal(current.amountPaise, 1865035);
      assert.equal(current.warranty.months, 60);
    };
    assert.equal(done.customer.phone, '+915550000199');
    assert.deepEqual(done.customer.vehicles.map(v => v.regNo), ['PB00TS0199']);
    expectSale(done.customer.vehicles[0].current);

    const row = ctx.app.db.q('SELECT amount_paise AS paise, typeof(amount_paise) AS kind FROM sales WHERE id = ?').get(done.saleId);
    assert.equal(row.paise, 1865035, 'Rs 18,650.35 is stored as 1865035 paise');
    assert.equal(row.kind, 'integer');

    // the same form arriving again a few minutes later (a retry on a bad connection) is still one sale
    ctx.tick(3 * MIN);
    const again = ok(await s.post('/api/staff/sales', body));
    assert.equal(again.duplicate, true);
    assert.equal(again.saleId, done.saleId);
    const fetched = ok(await s.get(`/api/staff/customers/${done.customerId}`)).customer;
    assert.equal(fetched.vehicles.length, 1);
    assert.equal(fetched.vehicles[0].earlier.length, 0);
    assert.equal(fetched.vehicles[0].history.length, 1);
    expectSale(fetched.vehicles[0].current);
    assert.ok(keysDeep(fetched).has('token'), 'staff do get the token, for the QR code on the bill');

    // the customer's own view
    const phone = await ctx.customer('5550000199', '0199');
    const res = await phone.get('/api/me');
    const me = ok(res);
    assert.equal(me.signedIn, true);
    assert.equal(me.hasPassport, true);
    assert.equal(me.phoneLast4, '0199');
    assert.equal(me.reminders.state, 'yes');
    assert.deepEqual(me.vehicles.map(v => v.regNo), ['PB00TS0199']);
    expectSale(me.vehicles[0].current);
    assert.ok(!keysDeep(me).has('token'), 'no token field anywhere in /api/me');
    assert.ok(!res.text.includes(token), 'the token value is not in /api/me');
    assert.ok(!res.text.includes('PB00DM'), 'nothing about other customers');
  });

  test('the sale form is checked on the server: unknown fields, an amount already in paise and wrong types are refused, and nothing is saved', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const customers = async () => ok(await s.get('/api/staff/status')).database.customers;
    const atStart = await customers();
    const cases = [
      [{ amountPaise: 5 }, 'amountPaise'],
      [{ customerId: 1 }, 'customerId'],
      [{ token: 'A'.repeat(22) }, 'token'],
      [{ amount: '21400' }, 'amount'],
      [{ amount: -1 }, 'amount'],
      [{ qty: '4' }, 'qty'],
      [{ qty: 0 }, 'qty'],
      [{ tyre: '<b>MRF</b>' }, 'tyre'],
      [{ fittedOn: '2026-10-07' }, 'fittedOn'],
      [{ phone: undefined }, 'phone'],
    ];
    for (const [over, field] of cases) {
      const e = refused(await s.post('/api/staff/sales', saleBody(over)), 400, 'invalid');
      assert.equal(e.field, field, JSON.stringify(over));
    }
    refused(await s.post('/api/staff/sales', '{"phone": '), 400, 'bad-json');
    refused(await s.post('/api/staff/sales', [saleBody()]), 400, 'invalid');
    refused(await s.post('/api/staff/sales', saleBody({ tyre: 'x'.repeat(20000) })), 413, 'too-large');
    assert.equal(await customers(), atStart);
    assert.deepEqual(await find(s, 'TS0199'), []);
  });

  test('a tyre size typed with its load index or ply rating is still recognised as the right kind of tyre', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const sizes = [
      ['90/100-10', 'two-wheeler'],
      ['90/100-10 53J', 'two-wheeler'],
      ['3.00-18 6PR', 'two-wheeler'],
      ['10.00 R20', 'truck'],
      ['10.00 R20 16PR', 'truck'],
      ['10.00-20 16PR', 'truck'],
      ['295/80 R22.5 152M', 'truck'],
      ['185/65 R15', 'car'],
      ['185/65 R15 88H', 'car'],
      ['185/65/15', 'car'],
    ];
    for (const [i, [size, kind]] of sizes.entries()) {
      const sale = ok(await s.post('/api/staff/sales', saleBody({ phone: `555000060${i}`, regNo: `PB00TS060${i}`, size })), `a sale of ${size}`);
      assert.equal(sale.profile, kind, `${size} is a ${kind} tyre`);
      const tyres = sale.customer.vehicles[0].current;
      assert.equal(tyres.size, size, 'the size is kept as it was typed');
      assert.equal(tyres.estimate.profile, kind);
      // rotation and alignment reminders are for cars only: a scooter or truck tyre taken for a car tyre would get them
      assert.equal(tyres.services.length > 0, kind === 'car', `${size}: service reminders`);
    }
  });

  test('demo mode refuses a real phone number in a sale', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const atStart = ok(await s.get('/api/staff/status')).database.customers;
    for (const phone of ['9876500001', '+91 98765 00001', '09876500001']) {
      const e = refused(await s.post('/api/staff/sales', saleBody({ phone })), 400, 'invalid');
      assert.equal(e.field, 'phone');
      assert.match(e.message, /demo/i);
      assert.match(e.message, /555/);
    }
    assert.equal(ok(await s.get('/api/staff/status')).database.customers, atStart);
    assert.deepEqual(await find(s, '9876500001'), []);
    assert.deepEqual(tablesMentioning(ctx.app.db, '9876500001'), []);
  });

  test('staff find a customer by part of the vehicle number or by digits of the phone number', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();

    const byPlate = await find(s, 'dm0003');
    assert.equal(byPlate.length, 1);
    assert.equal(byPlate[0].phone, '+915550000103');
    assert.deepEqual(byPlate[0].vehicles.map(v => v.regNo), ['PB00DM0003']);
    assert.ok(byPlate[0].customerId > 0 && byPlate[0].vehicles[0].id > 0);
    assert.match(byPlate[0].lastVisitOn, /^\d{4}-\d{2}-\d{2}$/);

    assert.deepEqual((await find(s, 'PB 00-DM')).map(r => r.phone).sort(), ['+915550000101', '+915550000102', '+915550000103', '+915550000104', '+915550000105', '+915550000106']);

    for (const q of ['0000104', '5550000104', '+91 55500 00104', '915550000104']) {
      assert.deepEqual((await find(s, q)).map(r => r.phone), ['+915550000104'], `phone search ${q}`);
    }
    assert.deepEqual(await find(s, 'ZZ99'), []);

    // too little to search on, wildcards that would list everyone, and things that are not text
    for (const q of ['', 'ab', '12', '%%%', '___', '%25%25%25', 'PB00*', "' OR 1=1 --", 'A'.repeat(25), 5550000104, ['PB00'], { $like: '%' }]) {
      assert.equal(refused(await lookup(s, q), 400, 'invalid').field, 'q', `search ${JSON.stringify(q)}`);
    }
    assert.equal(refused(await s.post('/api/staff/lookup', {}), 400, 'invalid').field, 'q');
    assert.equal(refused(await s.post('/api/staff/lookup', { q: 'PB00', limit: 1000 }), 400, 'invalid').field, 'limit');
  });

  test('the customer search travels in the body of a POST: a phone or vehicle number put in the address finds nothing', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    assert.equal((await find(s, '5550000104')).length, 1, 'the number is there to be found');

    // the old way, a GET with ?q=, is gone for signed-in staff too
    for (const p of ['/api/staff/lookup?q=5550000104', '/api/staff/lookup?q=dm0004', '/api/staff/lookup?q=PB00', '/api/staff/lookup']) {
      const res = await s.get(p);
      refused(res, 405, 'method');
      assert.ok(!res.text.includes('555000') && !res.text.includes('PB00DM'), `GET ${p} gave nothing away`);
    }
    // on the POST, only the body is read: a search in the address is not a search
    for (const body of [{}, { q: '' }]) {
      const res = await s.post('/api/staff/lookup?q=5550000104', body);
      assert.equal(refused(res, 400, 'invalid').field, 'q');
      assert.ok(!res.text.includes('555000'));
    }
    assert.deepEqual((await ok(await s.post('/api/staff/lookup?q=5550000104', { q: 'dm0003' })).results).map(r => r.phone), ['+915550000103'], 'the body decides, whatever the address says');
    // and it is a staff route like the others
    refused(await ctx.client().post('/api/staff/lookup', { q: '5550000104' }), 401, 'staff-signed-out');
    refused(await ctx.client().get('/api/staff/lookup?q=5550000104'), 405, 'method');
  });

  test('a logged visit adds the reading, stamps the visit card once a day and takes the service off the due list', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const [car] = await find(s, 'DM0002');               // sample car: fitted five months ago, rotation due, one stamp
    const vehicleId = car.vehicles[0].id;
    const dueFor = async () => ok(await s.get('/api/staff/due')).items.filter(i => i.customerId === car.customerId);
    assert.deepEqual((await dueFor()).map(i => i.type), ['service'], 'the sample car starts with a service due');
    const before = ok(await s.get(`/api/staff/customers/${car.customerId}`)).customer;
    assert.equal(before.card.stamps, 1);

    const visit = { vehicleId, odometerKm: 53100, treadMm: 6.24, services: ['rotation', 'alignment-check'], idem: 'visit-0002-first-try' };
    const done = ok(await s.post('/api/staff/visits', visit));
    assert.equal(done.duplicate, false);
    assert.equal(done.customerId, car.customerId);
    assert.deepEqual(done.earned, ['Pressure and tread check'], 'the second stamp on the card earns its free service');
    assert.equal(done.customer.card.stamps, 2);
    assert.ok(done.customer.card.available.some(g => g.name === 'Pressure and tread check' && g.source === 'card' && g.usedAt === null));
    const latest = done.customer.vehicles[0].history[0];
    assert.equal(latest.on, TODAY);
    assert.equal(latest.kind, 'service');
    assert.equal(latest.odometerKm, 53100);
    assert.equal(latest.treadMm, 6.2);
    assert.deepEqual(latest.services, ['Tyre rotation', 'Alignment check']);
    assert.equal(done.customer.vehicles[0].history.length, before.vehicles[0].history.length + 1);
    assert.deepEqual(await dueFor(), [], 'the rotation was done today, so nothing is due');

    // the same form twice is one visit; a second visit the same day is saved but earns no second stamp
    const twice = ok(await s.post('/api/staff/visits', visit));
    assert.equal(twice.duplicate, true);
    assert.equal(twice.visitId, done.visitId);
    const second = ok(await s.post('/api/staff/visits', { vehicleId, treadMm: 6.1, idem: 'visit-0002-second' }));
    assert.deepEqual(second.earned, []);
    assert.equal(second.customer.card.stamps, 2);
    assert.equal(second.customer.vehicles[0].history.length, before.vehicles[0].history.length + 2);

    // an odometer jump that looks like a slip of the finger is refused once, and saved when staff confirm it
    const jump = { vehicleId, odometerKm: 60000 };
    const e = refused(await s.post('/api/staff/visits', jump), 409, 'problem');
    assert.equal(e.field, 'odometerKm');
    assert.equal(e.canConfirm, true);
    ok(await s.post('/api/staff/visits', { ...jump, confirm: true }));

    // readings that cannot be right, and services that do not exist
    const lower = refused(await s.post('/api/staff/visits', { vehicleId, odometerKm: 40000 }), 409, 'problem');
    assert.equal(lower.field, 'odometerKm');
    assert.notEqual(lower.canConfirm, true, 'a reading below the fitting odometer cannot be confirmed through');
    refused(await s.post('/api/staff/visits', { vehicleId }), 409, 'problem');
    refused(await s.post('/api/staff/visits', { vehicleId: 999999, odometerKm: 61000 }), 409, 'problem');
    assert.equal(refused(await s.post('/api/staff/visits', { vehicleId, services: ['free-tyres'] }), 400, 'invalid').field, 'services');
    assert.equal(refused(await s.post('/api/staff/visits', { vehicleId, treadMm: '6.2' }), 400, 'invalid').field, 'treadMm');
    assert.equal(refused(await s.post('/api/staff/visits', { vehicleId, odometerKm: 61000, visitedOn: '2026-10-07' }), 400, 'invalid').field, 'visitedOn');
  });

  test('a tread reading more than 1 mm deeper than the tyres started with is questioned once, and saved when staff confirm it', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const readings = async sale => ok(await s.get(`/api/staff/customers/${sale.customerId}`)).customer.vehicles[0].history.map(h => h.treadMm);

    // a car tyre with nothing measured at fitting: on record as 7.5 mm when new
    const car = ok(await s.post('/api/staff/sales', saleBody()));
    const visit = body => s.post('/api/staff/visits', { vehicleId: car.vehicleId, ...body });
    const e = refused(await visit({ treadMm: 8.6 }), 409, 'problem');
    assert.equal(e.field, 'treadMm');
    assert.equal(e.canConfirm, true, 'staff are asked, not stopped: the tyre may really have started deeper');
    assert.match(e.message, /7\.5 mm/);
    assert.deepEqual(await readings(car), [null], 'the questioned reading was not saved');

    ok(await visit({ treadMm: 8.5 }), 'exactly 1 mm over is within what a gauge can be out by');
    const saved = ok(await visit({ treadMm: 8.6, confirm: true }));
    assert.equal(saved.duplicate, false);
    assert.deepEqual(await readings(car), [8.6, 8.5, null], 'newest first: the confirmed reading, the one that needed no question, the fitting');

    // when the new tread was measured at fitting, that is what a reading is compared with
    const deep = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000198', regNo: 'PB00TS0198', newTreadMm: 9 })));
    const deepVisit = body => s.post('/api/staff/visits', { vehicleId: deep.vehicleId, ...body });
    ok(await deepVisit({ treadMm: 10 }));
    const over = refused(await deepVisit({ treadMm: 10.1 }), 409, 'problem');
    assert.equal(over.field, 'treadMm');
    assert.equal(over.canConfirm, true);
    assert.match(over.message, /9 mm/);
    assert.deepEqual(await readings(deep), [10, null]);

    // a depth no tyre has is still refused outright, confirmed or not
    assert.equal(refused(await visit({ treadMm: 30.1, confirm: true }), 400, 'invalid').field, 'treadMm');
  });

  test('the due list prepares a message only for customers who agreed, and a reminder is recorded only as opened, marked sent or skipped', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const due = async () => ok(await s.get('/api/staff/due'));
    const mark = (key, status) => s.post('/api/staff/reminders', { key, status });

    const first = await due();
    assert.equal(first.today, TODAY);
    const agreed = first.items.filter(i => i.consent === 'yes');
    const notAsked = first.items.filter(i => i.consent === 'no');
    const stopped = first.items.filter(i => i.consent === 'stopped');
    assert.ok(agreed.length && notAsked.length && stopped.length, 'the demo list has customers who agreed, who were never asked and who stopped');
    assert.deepEqual(first.items.map(i => i.daysLeft), first.items.map(i => i.daysLeft).sort((a, b) => a - b), 'soonest first');
    assert.ok(!keysDeep(first).has('follow'), 'no item says anything about a follow-up note');
    for (const item of first.items) {
      assert.equal(item.status, 'ready', 'nothing is shown as sent before a person has done something');
      assert.equal(item.statusAt, null);
      // one note about replacement, or one about the services due since a given day: nothing else is ever listed
      assert.match(item.key, item.type === 'replacement' ? new RegExp(`^rep:${item.saleId}:1$`) : new RegExp(`^svc:${item.saleId}:\\d{4}-\\d{2}-\\d{2}$`));
      // each item says which vehicle it is about, so the staff page can open the customer on that vehicle
      const [owner] = await find(s, item.regNo);
      assert.equal(owner.customerId, item.customerId);
      assert.equal(item.vehicleId, owner.vehicles.find(v => v.regNo === item.regNo).id, `${item.key} carries the id of ${item.regNo}`);
      if (item.consent === 'yes') {
        assert.ok(item.message.includes(`${ctx.base}/stop/`), 'the message carries the stop link');
        assert.match(item.message, /STOP/);
        assert.ok(item.waUrl.startsWith(`https://wa.me/${item.phone.slice(1)}?text=`));
        assert.equal(decodeURIComponent(item.waUrl.split('?text=')[1]), item.message);
      } else {
        assert.equal(item.message, undefined, `no message for a customer whose consent is "${item.consent}"`);
        assert.equal(item.waUrl, undefined);
      }
    }

    const key = agreed[0].key;
    const statusOf = async k => (await due()).items.find(i => i.key === k);
    for (const bad of ['sent', 'delivered', 'ready', 'SENT', '']) {
      assert.equal(refused(await mark(key, bad), 400, 'invalid').field, 'status');
    }
    assert.equal((await statusOf(key)).status, 'ready');

    assert.equal(ok(await mark(key, 'opened')).item.status, 'opened');
    assert.equal((await statusOf(key)).status, 'opened', 'opening WhatsApp is not the same as sending');
    ctx.tick(2 * MIN);
    ok(await mark(key, 'marked_sent'));
    const sent = await statusOf(key);
    assert.equal(sent.status, 'marked_sent');
    assert.equal(sent.statusAt, ctx.now());
    ok(await mark(agreed[agreed.length - 1].key, 'skipped'));
    assert.equal((await statusOf(agreed[agreed.length - 1].key)).status, 'skipped');

    // no consent, no record of a reminder
    for (const item of [...notAsked, ...stopped]) {
      refused(await mark(item.key, 'marked_sent'), 409, 'not-due');
      assert.equal((await statusOf(item.key)).status, 'ready');
    }
    refused(await mark('rep:999999:1', 'marked_sent'), 409, 'not-due');
    refused(await mark('not-a-reminder', 'marked_sent'), 409, 'not-due');
    // there is one replacement note per set of tyres: a second, follow-up note cannot be recorded for anyone
    const replacement = agreed.find(i => i.type === 'replacement');
    assert.ok(replacement, 'the demo list has a replacement reminder for a customer who agreed');
    for (const status of ['opened', 'marked_sent', 'skipped']) {
      refused(await mark(replacement.key.replace(/:1$/, ':2'), status), 409, 'not-due');
      refused(await mark(replacement.key.replace(/:1$/, ':0'), status), 409, 'not-due');
    }
    assert.ok(!(await due()).items.some(i => /^rep:\d+:(?!1$)/.test(i.key)), 'and none is listed');
    assert.ok(!tablesMentioning(ctx.app.db, replacement.key.replace(/:1$/, ':2')).length, 'and none was written down');

    // consent withdrawn: the prepared message goes at once
    ok(await s.post(`/api/staff/customers/${agreed[0].customerId}/reminders`, { on: false }));
    const after = await statusOf(key);
    assert.equal(after.consent, 'stopped');
    assert.equal(after.message, undefined);
    assert.equal(after.waUrl, undefined);
    refused(await mark(key, 'marked_sent'), 409, 'not-due');
  });

  test('a replacement reminder is one note with no follow-up; it is offered again only when a later reading moves the date more than twice the lead time past the day the note was logged', async t => {
    const ctx = await boot(t);
    let s = await ctx.staff();
    const LEAD = SETTINGS.reminders.replacementLeadDays;
    // Fitted 1,360 days ago. With no reading since, 45,000 km at 1,000 km a month puts replacement 1,370 days
    // after fitting: ten days from now.
    const fittedOn = dayPlus(TODAY, -1360), odometerKm = 10000;
    const fit = async n => ok(await s.post('/api/staff/sales', saleBody({ phone: `555000050${n}`, regNo: `PB00TS050${n}`, fittedOn, odometerKm, remindersOk: true })));
    const plain = await fit(1), nudged = await fit(2), moved = await fit(3);
    const itemsFor = async sale => ok(await s.get('/api/staff/due')).items.filter(i => i.saleId === sale.saleId);
    const dueOn = async sale => ok(await s.get(`/api/staff/customers/${sale.customerId}`)).customer.vehicles[0].current.estimate.dueOn;
    const mark = (key, status) => s.post('/api/staff/reminders', { key, status });
    const laterOn = async days => { ctx.tick(days * DAY); s = await ctx.staff(); };   // a staff sign-in does not last the night

    const sentAt = ctx.now();
    for (const sale of [plain, nudged, moved]) {
      const [item] = await itemsFor(sale);
      assert.equal(item.key, `rep:${sale.saleId}:1`);
      assert.equal(item.type, 'replacement');
      assert.equal(item.dueOn, dayPlus(TODAY, 10));
      assert.equal(item.daysLeft, 10);
      ok(await mark(item.key, 'marked_sent'));
    }

    /* An odometer reading today changes the estimate: these tyres have covered less ground than a typical car's,
       so the 45,000 km will take longer. Days from fitting to replacement = 1,360 x 45,000 / km covered.
       43,099 km gives 1,420 days: 60 days after the note, exactly twice the lead time.
       43,069 km gives 1,421 days: 61 days after the note, one day more than twice the lead time. */
    ok(await s.post('/api/staff/visits', { vehicleId: nudged.vehicleId, odometerKm: odometerKm + 43099 }));
    ok(await s.post('/api/staff/visits', { vehicleId: moved.vehicleId, odometerKm: odometerKm + 43069 }));
    assert.equal(await dueOn(nudged), dayPlus(TODAY, 2 * LEAD));
    assert.equal(await dueOn(moved), dayPlus(TODAY, 2 * LEAD + 1));
    assert.deepEqual(await itemsFor(nudged), [], 'two months away: off the list for now');
    assert.deepEqual(await itemsFor(moved), []);

    // twenty days on, the tyres with no reading are ten days overdue: still the one note, still marked sent
    await laterOn(20);
    let items = await itemsFor(plain);
    assert.equal(items.length, 1);
    assert.equal(items[0].key, `rep:${plain.saleId}:1`);
    assert.equal(items[0].daysLeft, -10);
    assert.equal(items[0].status, 'marked_sent');
    assert.equal(items[0].statusAt, sentAt);
    assert.ok(!keysDeep(items).has('follow'));
    for (const status of ['opened', 'marked_sent', 'skipped']) refused(await mark(`rep:${plain.saleId}:2`, status), 409, 'not-due');

    // thirty days on, the first changed date is a lead time away. It moved by twice the lead time, not more: the note stands
    await laterOn(10);
    items = await itemsFor(nudged);
    assert.equal(items.length, 1);
    assert.equal(items[0].key, `rep:${nudged.saleId}:1`);
    assert.equal(items[0].daysLeft, LEAD);
    assert.equal(items[0].status, 'marked_sent');
    assert.equal(items[0].statusAt, sentAt);
    assert.deepEqual(await itemsFor(moved), [], 'one more day to go');

    // The next day the other comes round. Its date is 61 days after the note, so that note was about a
    // different date: the reminder is offered afresh, under the same key.
    await laterOn(1);
    items = await itemsFor(moved);
    assert.equal(items.length, 1);
    assert.equal(items[0].key, `rep:${moved.saleId}:1`);
    assert.equal(items[0].daysLeft, LEAD);
    assert.equal(items[0].status, 'ready');
    assert.equal(items[0].statusAt, null);
    assert.equal(typeof items[0].message, 'string', 'with a message prepared, as for any reminder not yet sent');
    assert.equal((await itemsFor(nudged))[0].status, 'marked_sent');
    assert.equal((await itemsFor(plain))[0].status, 'marked_sent', 'and the overdue tyres have still had their one note');

    // sent again, it is recorded again against the new date, and stays recorded
    assert.equal(ok(await mark(items[0].key, 'marked_sent')).item.statusAt, ctx.now());
    const resentAt = ctx.now();
    await laterOn(5);
    items = await itemsFor(moved);
    assert.equal(items[0].status, 'marked_sent');
    assert.equal(items[0].statusAt, resentAt);
  });

  test('a service reminder keeps its key, and so what staff did with it, when an odometer reading moves the date; a new round starts only once the service is done', async t => {
    const ctx = await boot(t);
    let s = await ctx.staff();
    const [car] = await find(s, 'DM0002');               // sample car: fitted 148 days ago, no reading since, rotation and alignment check never done
    const vehicleId = car.vehicles[0].id;
    const tyres = ok(await s.get(`/api/staff/customers/${car.customerId}`)).customer.vehicles[0].current;
    const itemsFor = async () => ok(await s.get('/api/staff/due')).items.filter(i => i.customerId === car.customerId);
    const visit = body => s.post('/api/staff/visits', { vehicleId, ...body });

    let items = await itemsFor();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'service');
    assert.equal(items[0].key, `svc:${tyres.id}:${tyres.fittedOn}`, 'never done on these tyres, so the round is counted from the fitting day');
    assert.deepEqual(items[0].services, ['Tyre rotation', 'Alignment check']);
    assert.equal(items[0].dueOn, dayPlus(tyres.fittedOn, 152), 'at a typical 1,000 km a month, 5,000 km takes five months');
    const key = items[0].key;
    ctx.tick(MIN);
    ok(await s.post('/api/staff/reminders', { key, status: 'marked_sent' }));
    const sentAt = ctx.now();

    // the odometer shows this car covers about 1,520 km a month, not 1,000: its 5,000 km were up seven weeks ago
    ok(await visit({ odometerKm: tyres.odometerKm + 7400 }));
    items = await itemsFor();
    assert.equal(items.length, 1);
    assert.equal(items[0].dueOn, dayPlus(tyres.fittedOn, 100), 'the date moved');
    assert.equal(items[0].by, 'distance');
    assert.equal(items[0].key, key, 'the key did not');
    assert.equal(items[0].status, 'marked_sent', 'so no second message is prepared for the same round');
    assert.equal(items[0].statusAt, sentAt);

    // the rotation is done, the alignment check is not: what is still owed belongs to the same round
    ok(await visit({ services: ['rotation'] }));
    items = await itemsFor();
    assert.deepEqual(items.map(i => i.services), [['Alignment check']]);
    assert.equal(items[0].key, key);
    assert.equal(items[0].status, 'marked_sent');

    // both done: nothing is due until the next 5,000 km are nearly up, and that is a new reminder
    ok(await visit({ services: ['alignment-check'] }));
    assert.deepEqual(await itemsFor(), []);
    ctx.tick(92 * DAY);
    s = await ctx.staff();
    assert.deepEqual(await itemsFor(), [], 'eight days before it is due again');
    ctx.tick(DAY);
    s = await ctx.staff();
    items = await itemsFor();
    assert.equal(items.length, 1);
    assert.equal(items[0].key, `svc:${tyres.id}:${TODAY}`, 'the new round is counted from the day the services were last done');
    assert.equal(items[0].daysLeft, SETTINGS.reminders.serviceLeadDays);
    assert.deepEqual(items[0].services, ['Tyre rotation', 'Alignment check']);
    assert.equal(items[0].status, 'ready');
    assert.equal(items[0].statusAt, null);
  });

  test('reminders: staff can record a yes given at the counter and can always stop, but after a stop only the customer can turn them back on', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const state = async id => ok(await s.get(`/api/staff/customers/${id}`)).customer.reminders;
    const turn = (id, on) => s.post(`/api/staff/customers/${id}/reminders`, { on });
    const dueFor = async id => ok(await s.get('/api/staff/due')).items.filter(i => i.customerId === id);

    // never asked (the sample scooter): a yes at the counter is recorded as given to staff
    const [scooter] = await find(s, 'DM0003');
    assert.equal((await state(scooter.customerId)).state, 'no');
    const yes = ok(await turn(scooter.customerId, true)).customer.reminders;
    assert.equal(yes.state, 'yes');
    assert.equal(yes.by, 'staff');
    assert.equal(yes.at, ctx.now());
    const [item] = await dueFor(scooter.customerId);
    assert.equal(typeof item.message, 'string');

    // the customer uses the stop link in the message
    const stopPath = new URL(/https?:\/\/\S+\/stop\/[A-Za-z0-9_-]+/.exec(item.message)[0]).pathname;
    assert.equal((await ctx.client().get(stopPath)).status, 200);
    assert.equal((await state(scooter.customerId)).state, 'yes', 'opening the link changes nothing (link previews open it too)');
    const pressed = await ctx.client().request('POST', '/stop', { body: 't=' + stopPath.split('/').pop(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-hta': null } });
    assert.equal(pressed.status, 200);
    assert.equal((await state(scooter.customerId)).state, 'stopped');
    refused(await turn(scooter.customerId, true), 409, 'stopped');
    assert.equal((await state(scooter.customerId)).state, 'stopped');
    for (const i of await dueFor(scooter.customerId)) assert.equal(i.message, undefined);

    // a customer who stopped from their own passport
    const [car] = await find(s, 'DM0002');
    const owner = await ctx.customer('5550000102', '0002');
    assert.equal(ok(await owner.post('/api/me/reminders', { on: false })).reminders, 'stopped');
    refused(await turn(car.customerId, true), 409, 'stopped');
    // ticking the reminders box on a new sale does not override the stop either
    const sale = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000102', regNo: 'PB00DM0002', odometerKm: 90000, remindersOk: true })));
    assert.equal(sale.consent, 'stopped');
    assert.equal(sale.customer.reminders.state, 'stopped');
    // the customer turns them back on
    assert.equal(ok(await owner.post('/api/me/reminders', { on: true })).reminders, 'yes');
    const back = await state(car.customerId);
    assert.equal(back.state, 'yes');
    assert.equal(back.by, 'customer');

    // and staff can always stop
    assert.equal(ok(await turn(car.customerId, false)).customer.reminders.state, 'stopped');
    refused(await turn(999999, true), 404, 'not-found');
    assert.equal(refused(await turn(car.customerId, 'yes'), 400, 'invalid').field, 'on');
  });

  test('staff delete a customer on request only with the right last four digits of the phone, and then nothing is left', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const [car] = await find(s, 'DM0002');               // has a sale, a free service, an invitation and a breakdown on file
    const owner = await ctx.customer('5550000102', '0002');
    assert.equal(ok(await owner.get('/api/me')).hasPassport, true);
    assert.ok(ok(await s.get('/api/staff/breakdowns')).items.some(i => i.customerId === car.customerId));
    assert.ok(tablesMentioning(ctx.app.db, '5550000102').includes('customers'));
    const del = last4 => s.post(`/api/staff/customers/${car.customerId}/delete`, last4 === undefined ? {} : { last4 });

    for (const wrong of ['0101', '2010', '102', '00102', 'abcd']) {
      assert.equal(refused(await del(wrong), 400, 'invalid').field, 'last4', `last4 "${wrong}"`);
    }
    assert.equal(refused(await del(undefined), 400, 'invalid').field, 'last4');
    ok(await s.get(`/api/staff/customers/${car.customerId}`), 'the customer after wrong digits');

    ok(await del('0102'));
    refused(await s.get(`/api/staff/customers/${car.customerId}`), 404, 'not-found');
    assert.deepEqual(await find(s, 'DM0002'), []);
    assert.deepEqual(await find(s, '5550000102'), []);
    assert.ok(!ok(await s.get('/api/staff/due')).items.some(i => i.customerId === car.customerId));
    assert.ok(!ok(await s.get('/api/staff/breakdowns')).items.some(i => i.customerId === car.customerId));
    assert.equal(ok(await owner.get('/api/me')).signedIn, false, 'their phone is signed out');
    assert.deepEqual(tablesMentioning(ctx.app.db, '5550000102'), [], 'no table still holds the number');
    assert.deepEqual(tablesMentioning(ctx.app.db, 'PB00DM0002'), [], 'no table still holds the vehicle number');

    ctx.tick(2 * MIN);
    assert.equal(ok(await ctx.client().post('/api/auth/request', { phone: '5550000102' })).demo.code, null, 'the number can no longer get a sign-in code');
    refused(await del('0102'), 404, 'not-found');
  });

  test('staff correct a mistyped vehicle number', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const [regular] = await find(s, 'DM0001');
    const vehicleId = regular.vehicles[0].id;
    const before = ok(await s.get(`/api/staff/customers/${regular.customerId}`)).customer;
    const rename = (id, regNo) => s.post(`/api/staff/vehicles/${id}`, { regNo });

    const renamed = ok(await rename(vehicleId, 'pb-00 dm 9001')).customer;
    assert.deepEqual(renamed.vehicles.map(v => v.regNo), ['PB00DM9001']);
    assert.deepEqual(renamed.vehicles[0].history, before.vehicles[0].history, 'the readings stay with the vehicle');
    assert.deepEqual(await find(s, 'DM0001'), []);
    assert.deepEqual((await find(s, 'DM9001')).map(r => r.customerId), [regular.customerId]);
    await ctx.customer('5550000101', '9001');             // the customer now signs in with the corrected plate

    for (const bad of ['x', 'PB<10>', 'A'.repeat(13), 12345]) {
      assert.equal(refused(await rename(vehicleId, bad), 400, 'invalid').field, 'regNo');
    }
    ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000101', regNo: 'PB00TS7777' })));
    assert.equal(refused(await rename(vehicleId, 'PB00TS7777'), 409, 'problem').field, 'regNo', 'two vehicles of one customer cannot share a number');
    refused(await rename(999999, 'PB00TS8888'), 409, 'problem');
    assert.deepEqual((await find(s, 'DM9001')).map(r => r.customerId), [regular.customerId]);
  });

  test('a sale entered by mistake can be removed for one day', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);                                       // the counter opens a little after the sample data was written
    const customers = async staff => ok(await staff.get('/api/staff/status')).database.customers;
    const atStart = await customers(s);

    // a brand new customer typed with the wrong number: removing the sale removes them completely
    const wrong = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000301', regNo: 'PB00TS0301' })));
    assert.equal(await customers(s), atStart + 1);
    const holder = await ctx.customer('5550000301', '0301');   // whoever holds that number could open the passport meanwhile
    assert.equal(ok(await holder.get('/api/me')).hasPassport, true);
    assert.equal(ok(await s.post(`/api/staff/sales/${wrong.saleId}/void`)).customer, null);
    assert.equal(await customers(s), atStart);
    assert.deepEqual(await find(s, 'TS0301'), []);
    assert.deepEqual(await find(s, '5550000301'), []);
    assert.equal(ok(await holder.get('/api/me')).signedIn, false, 'and is signed out when the sale goes');
    assert.deepEqual(tablesMentioning(ctx.app.db, '5550000301'), []);
    assert.deepEqual(tablesMentioning(ctx.app.db, 'PB00TS0301'), []);
    refused(await s.post(`/api/staff/sales/${wrong.saleId}/void`), 409, 'problem');

    // a customer with other tyres on record keeps them, and the stamp the mistaken sale gave goes with it
    const [regular] = await find(s, 'DM0001');
    const before = ok(await s.get(`/api/staff/customers/${regular.customerId}`)).customer;
    const extra = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000101', regNo: 'PB00TS0302' })));
    assert.equal(extra.customerId, regular.customerId);
    assert.equal(extra.customer.vehicles.length, 2);
    assert.equal(extra.customer.card.stamps, before.card.stamps + 1);
    const kept = ok(await s.post(`/api/staff/sales/${extra.saleId}/void`)).customer;
    assert.deepEqual(kept.vehicles, before.vehicles);
    assert.equal(kept.card.stamps, before.card.stamps);
    assert.deepEqual(kept.reminders, before.reminders);

    // for one day and no longer: after that it is part of the record
    const inTime = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000304', regNo: 'PB00TS0304' })));
    const late = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000303', regNo: 'PB00TS0303' })));
    ctx.tick(24 * HOUR - MIN);
    const nextDay = await ctx.staff();
    assert.equal(ok(await nextDay.post(`/api/staff/sales/${inTime.saleId}/void`), 'a minute short of a day').customer, null);
    ctx.tick(2 * MIN);
    refused(await nextDay.post(`/api/staff/sales/${late.saleId}/void`), 409, 'problem');
    assert.equal((await find(nextDay, 'TS0303')).length, 1);
    assert.equal(await customers(nextDay), atStart + 1);
  });

  test('removing a mistaken sale keeps the visits logged since: they go back to the tyres that were on the vehicle before, or go with a vehicle left with no tyres on record', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);
    const view = async id => ok(await s.get(`/api/staff/customers/${id}`)).customer;
    const [regular] = await find(s, 'DM0001');
    const vehicleId = regular.vehicles[0].id;
    const before = await view(regular.customerId);
    const oldTyres = before.vehicles[0].current;

    // new tyres entered on the regular customer's car by mistake, and a visit logged on them before anyone noticed
    const mistake = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000101', regNo: 'PB00DM0001', odometerKm: 52000 })));
    assert.equal(mistake.vehicleId, vehicleId);
    assert.equal(mistake.customer.vehicles[0].current.id, mistake.saleId);
    ctx.tick(MIN);
    const check = ok(await s.post('/api/staff/visits', { vehicleId, odometerKm: 52040, services: ['alignment-check'] }));
    const during = (await view(regular.customerId)).vehicles[0];
    assert.equal(during.history[0].saleId, mistake.saleId, 'the visit is logged against the newest tyres');
    assert.equal(during.history.length, before.vehicles[0].history.length + 2);

    ctx.tick(MIN);
    const kept = ok(await s.post(`/api/staff/sales/${mistake.saleId}/void`)).customer;
    const car = kept.vehicles[0];
    assert.equal(kept.vehicles.length, 1);
    assert.equal(car.current.id, oldTyres.id, 'the tyres from before are the current ones again');
    assert.deepEqual(car.earlier, before.vehicles[0].earlier);
    assert.deepEqual(car.history[0], { on: TODAY, kind: 'service', saleId: oldTyres.id, odometerKm: 52040, treadMm: null, services: ['Alignment check'] }, 'the later visit is kept, and now belongs to the tyres from before');
    assert.deepEqual(car.history.slice(1), before.vehicles[0].history, 'only the purchase entry of the removed sale is gone');
    assert.deepEqual({ ...ctx.app.db.q('SELECT sale_id AS saleId, kind FROM visits WHERE id = ?').get(check.visitId) }, { saleId: oldTyres.id, kind: 'service' });
    assert.equal(ctx.app.db.q('SELECT COUNT(*) AS n FROM visits WHERE vehicle_id = ? AND sale_id IS NULL').get(vehicleId).n, 0, 'no visit is left belonging to no tyres');

    // a vehicle that was on record only through the mistaken sale goes, and a visit logged on it goes with it
    const extra = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000101', regNo: 'PB00TS0302' })));
    const stray = ok(await s.post('/api/staff/visits', { vehicleId: extra.vehicleId, odometerKm: 12100, treadMm: 7.4 }));
    assert.equal((await view(regular.customerId)).vehicles.length, 2);
    ctx.tick(MIN);
    const after = ok(await s.post(`/api/staff/sales/${extra.saleId}/void`)).customer;
    assert.deepEqual(after.vehicles, kept.vehicles);
    assert.deepEqual(await find(s, 'TS0302'), []);
    assert.equal(ctx.app.db.q('SELECT COUNT(*) AS n FROM visits WHERE id = ? OR vehicle_id = ?').get(stray.visitId, extra.vehicleId).n, 0);
    assert.equal(refused(await s.post('/api/staff/visits', { vehicleId: extra.vehicleId, odometerKm: 12200 }), 409, 'problem').field, 'vehicleId');
  });

  test('removing a sale takes back the yes to reminders ticked on it and any reminder marked against it, and nothing that came from elsewhere', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);
    const view = async id => ok(await s.get(`/api/staff/customers/${id}`)).customer;
    const logged = () => ctx.app.db.q('SELECT key, status FROM reminder_log ORDER BY key').all().map(r => ({ ...r }));
    const fittedOn = dayPlus(TODAY, -1360);              // old enough that a replacement reminder is due at once

    // the scooter's owner was never asked about reminders; the box is ticked on a sale that turns out to be a mistake
    const [scooter] = await find(s, 'DM0003');
    const before = await view(scooter.customerId);
    assert.equal(before.reminders.state, 'no');
    const mistake = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000103', regNo: 'PB00TS0603', fittedOn, remindersOk: true })));
    assert.equal(mistake.consent, 'yes');
    assert.equal(mistake.customer.reminders.by, 'staff');
    const key = `rep:${mistake.saleId}:1`;
    ok(await s.post('/api/staff/reminders', { key, status: 'marked_sent' }));
    assert.deepEqual(logged(), [{ key, status: 'marked_sent' }]);

    ctx.tick(MIN);
    const kept = ok(await s.post(`/api/staff/sales/${mistake.saleId}/void`)).customer;
    assert.deepEqual(kept.reminders, before.reminders, 'the yes went with the sale it was ticked on');
    assert.deepEqual(logged(), [], 'and so did the record of the reminder');
    const left = ok(await s.get('/api/staff/due')).items.filter(i => i.customerId === scooter.customerId);
    assert.ok(left.length > 0 && left.every(i => i.message === undefined && i.waUrl === undefined), 'nothing is prepared for a customer who, once again, never agreed');
    // it was never a stop, so a yes given at the counter can still be recorded
    assert.equal(ok(await s.post(`/api/staff/customers/${scooter.customerId}/reminders`, { on: true })).customer.reminders.state, 'yes');

    // a yes already on record is not the sale's to take back, and neither is a reminder marked for other tyres
    const [regular] = await find(s, 'DM0001');
    const regularBefore = await view(regular.customerId);
    assert.equal(regularBefore.reminders.state, 'yes');
    const [note] = ok(await s.get('/api/staff/due')).items.filter(i => i.customerId === regular.customerId);
    ok(await s.post('/api/staff/reminders', { key: note.key, status: 'marked_sent' }));
    const second = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000101', regNo: 'PB00TS0601', fittedOn, remindersOk: true })));
    assert.equal(second.consent, 'yes');
    ok(await s.post('/api/staff/reminders', { key: `rep:${second.saleId}:1`, status: 'opened' }));
    assert.equal(logged().length, 2);
    ctx.tick(MIN);
    const regularKept = ok(await s.post(`/api/staff/sales/${second.saleId}/void`)).customer;
    assert.deepEqual(regularKept.reminders, regularBefore.reminders);
    assert.deepEqual(logged(), [{ key: note.key, status: 'marked_sent' }]);
  });

  test('a referred friend whose first sale was removed and entered again still gets the free service', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);
    const [referrer] = await find(s, 'DM0001');
    const code = ok(await s.get(`/api/staff/customers/${referrer.customerId}`)).customer.referral.code;
    const friend = { phone: '5550000201', regNo: 'PB00TS0201', referralCode: code };
    const welcome = sale => sale.customer.card.available.filter(g => g.source === 'referral');

    const first = ok(await s.post('/api/staff/sales', saleBody(friend)));
    assert.equal(first.referral.friendGot, true);
    assert.equal(welcome(first).length, 1);
    ctx.tick(MIN);
    assert.equal(ok(await s.post(`/api/staff/sales/${first.saleId}/void`)).customer, null);

    // the same sale again, with the tyre name put right
    ctx.tick(MIN);
    const second = ok(await s.post('/api/staff/sales', saleBody({ ...friend, tyre: 'MRF ZLP' })));
    assert.equal(second.duplicate, false);
    assert.equal(second.referral.friendGot, true);
    assert.equal(welcome(second).length, 1, 'the friend should hold their free service after the corrected sale');
  });

  test('removing a referred sale typed with the wrong phone number leaves nothing about that number behind', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);
    const [referrer] = await find(s, 'DM0001');
    const code = ok(await s.get(`/api/staff/customers/${referrer.customerId}`)).customer.referral.code;
    const wrong = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000301', regNo: 'PB00TS0301', referralCode: code })));
    assert.ok(tablesMentioning(ctx.app.db, '5550000301').includes('referrals'), 'the invitation typed in with the sale is on record');
    ctx.tick(MIN);
    assert.equal(ok(await s.post(`/api/staff/sales/${wrong.saleId}/void`)).customer, null);
    assert.deepEqual(tablesMentioning(ctx.app.db, '5550000301'), []);
  });

  test('the customer who invited a friend earns one free service for that friend, even if the sale was first typed with the wrong number and removed', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);
    const view = async id => ok(await s.get(`/api/staff/customers/${id}`)).customer;
    const [referrer] = await find(s, 'DM0001');
    const before = await view(referrer.customerId);
    const friend = { regNo: 'PB00TS0201', referralCode: before.referral.code };

    const wrong = ok(await s.post('/api/staff/sales', saleBody({ ...friend, phone: '5550000301' })));
    assert.equal(wrong.referral.referrerGot, true);
    assert.equal((await view(referrer.customerId)).card.available.length, before.card.available.length + 1);
    ctx.tick(MIN);
    ok(await s.post(`/api/staff/sales/${wrong.saleId}/void`));
    const between = await view(referrer.customerId);
    assert.equal(between.referral.joined, before.referral.joined, 'with the sale gone, nobody has joined');
    assert.deepEqual(between.card.available, before.card.available, 'and the free service it earned is taken back');

    ctx.tick(MIN);
    ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000399', regNo: 'PB00TS0399' })));   // someone else is served in between
    const right = ok(await s.post('/api/staff/sales', saleBody({ ...friend, phone: '5550000302' })));
    assert.equal(right.referral.friendGot, true);

    const after = await view(referrer.customerId);
    assert.equal(after.referral.joined, before.referral.joined + 1, 'one friend joined');
    assert.equal(after.card.available.length, before.card.available.length + 1, 'one free service for one friend');
  });

  test('removing the first sale of a friend who arrived by invitation opens the invitation again, so the corrected sale still rewards both, once', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);
    const view = async id => ok(await s.get(`/api/staff/customers/${id}`)).customer;
    const [referrer] = await find(s, 'DM0001');
    const before = await view(referrer.customerId);
    const phone = '5550000701';

    // the friend opens the invitation link and signs in, before buying anything
    const friend = ctx.client();
    const asked = ok(await friend.post('/api/auth/request', { phone, ref: before.referral.code }));
    assert.match(asked.demo.code, /^\d{6}$/, 'an invited number is given a code');
    ok(await friend.post('/api/auth/verify', { phone, code: asked.demo.code, ref: before.referral.code }));
    const waiting = ok(await friend.get('/api/me'));
    assert.equal(waiting.hasPassport, false);
    assert.equal(waiting.invited, true);

    // the sale is entered without the code: the invitation on record is enough
    ctx.tick(10 * MIN);
    const first = ok(await s.post('/api/staff/sales', saleBody({ phone, regNo: 'PB00TS0701' })));
    assert.deepEqual([first.referral.friendGot, first.referral.referrerGot], [true, true]);
    assert.equal((await view(referrer.customerId)).referral.joined, before.referral.joined + 1);
    assert.equal(ok(await friend.get('/api/me')).hasPassport, true);

    // it was typed wrongly, and is removed
    ctx.tick(MIN);
    assert.equal(ok(await s.post(`/api/staff/sales/${first.saleId}/void`)).customer, null);
    const between = await view(referrer.customerId);
    assert.equal(between.referral.joined, before.referral.joined, 'nobody has joined yet after all');
    assert.deepEqual(between.card.available, before.card.available, 'and the free service that sale earned the referrer is taken back');
    assert.equal(ok(await friend.get('/api/me')).signedIn, false, 'the passport that sale opened is closed');
    assert.deepEqual(tablesMentioning(ctx.app.db, phone), ['referrals'], 'all that is left of the friend is the invitation they accepted themselves');
    assert.equal(ctx.app.db.q('SELECT converted_at AS c FROM referrals WHERE friend_phone = ?').get('+91' + phone).c, null, 'and it is open again');
    // so the friend is once more an invited number, and can sign in as one
    const again = ok(await friend.post('/api/auth/request', { phone }));
    assert.match(again.demo.code, /^\d{6}$/);
    ok(await friend.post('/api/auth/verify', { phone, code: again.demo.code }));
    assert.equal(ok(await friend.get('/api/me')).invited, true);

    // entered again, correctly: both are rewarded, and the referrer only once
    ctx.tick(MIN);
    const second = ok(await s.post('/api/staff/sales', saleBody({ phone, regNo: 'PB00TS0701', tyre: 'MRF ZLP' })));
    assert.deepEqual([second.referral.friendGot, second.referral.referrerGot], [true, true]);
    assert.equal(second.customer.card.available.filter(g => g.source === 'referral').length, 1);
    const after = await view(referrer.customerId);
    assert.equal(after.referral.joined, before.referral.joined + 1);
    assert.equal(after.card.available.length, before.card.available.length + 1);
  });

  test('a referred friend\'s sale sent twice within two minutes is saved once and answered as a duplicate, not refused because the customer "has bought here before"', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);
    const view = async id => ok(await s.get(`/api/staff/customers/${id}`)).customer;
    const [referrer] = await find(s, 'DM0001');
    const before = await view(referrer.customerId);
    // no idem label: the form typed a second time, or a page that never got the first answer
    const body = saleBody({ phone: '5550000211', regNo: 'PB00TS0211', referralCode: before.referral.code });

    const first = ok(await s.post('/api/staff/sales', body));
    assert.equal(first.duplicate, false);
    assert.equal(first.referral.friendGot, true);
    ctx.tick(119 * SEC);
    const again = ok(await s.post('/api/staff/sales', body), 'the same sale a second time, just inside two minutes');
    assert.equal(again.duplicate, true);
    assert.equal(again.saleId, first.saleId);
    assert.equal(again.referral, null, 'nothing is earned twice');
    assert.deepEqual(again.earned, []);
    assert.equal(again.customer.vehicles.length, 1);
    assert.equal(again.customer.vehicles[0].history.length, 1);
    assert.equal(again.customer.card.available.length, 1);
    assert.equal((await view(referrer.customerId)).referral.joined, before.referral.joined + 1);

    // past two minutes it is no longer taken for the same sale, and a second purchase cannot claim a referral
    ctx.tick(2 * SEC);
    assert.equal(refused(await s.post('/api/staff/sales', body), 409, 'problem').field, 'referralCode');
    assert.equal((await view(first.customerId)).vehicles[0].history.length, 1, 'nothing was saved');
    assert.equal((await view(referrer.customerId)).referral.joined, before.referral.joined + 1);
  });

  test('row ids are never handed out twice: what replaces a removed sale gets new ids for the customer, the vehicle, the sale, its visit and its free service', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    ctx.tick(MIN);
    const [referrer] = await find(s, 'DM0001');
    const code = ok(await s.get(`/api/staff/customers/${referrer.customerId}`)).customer.referral.code;
    const enter = async n => {
      const sale = ok(await s.post('/api/staff/sales', saleBody({ phone: `555000041${n}`, regNo: `PB00TS041${n}`, referralCode: code })));
      const visit = ok(await s.post('/api/staff/visits', { vehicleId: sale.vehicleId, odometerKm: 12050 }));
      return { customer: sale.customerId, vehicle: sale.vehicleId, sale: sale.saleId, visit: visit.visitId, grant: sale.customer.card.available[0].id };
    };
    const first = await enter(1);
    ctx.tick(MIN);
    assert.equal(ok(await s.post(`/api/staff/sales/${first.sale}/void`)).customer, null);   // the newest row of every table is now gone
    ctx.tick(MIN);
    const second = await enter(2);
    for (const what of Object.keys(first)) {
      assert.ok(Number.isInteger(first[what]) && second[what] > first[what], `the removed ${what} had id ${first[what]}; the next one got ${second[what]}`);
    }
  });

  test('refer a friend gives both a free service when the friend buys, and staff mark a free service used with ten minutes to undo', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const view = async id => ok(await s.get(`/api/staff/customers/${id}`)).customer;
    const [referrer] = await find(s, 'DM0001');
    const before = await view(referrer.customerId);

    const sale = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000201', regNo: 'PB00TS0201', referralCode: before.referral.code })));
    assert.equal(sale.referral.friendGot, true);
    assert.equal(sale.referral.referrerGot, true);
    assert.equal(sale.referral.service, 'Tyre rotation');
    const after = await view(referrer.customerId);
    assert.equal(after.card.available.length, before.card.available.length + 1, 'the customer who invited them has one more free service');
    assert.equal(after.referral.joined, before.referral.joined + 1);
    assert.equal(sale.customer.card.available.length, 1);
    const grant = sale.customer.card.available[0];
    assert.equal(grant.name, 'Tyre rotation');
    assert.equal(grant.source, 'referral');
    assert.equal(grant.usedAt, null);

    // a code that does not exist, or the customer's own, earns nothing and saves nothing
    assert.equal(refused(await s.post('/api/staff/sales', saleBody({ phone: '5550000202', regNo: 'PB00TS0202', referralCode: 'ZZZZ9999' })), 409, 'problem').field, 'referralCode');
    assert.deepEqual(await find(s, 'TS0202'), []);

    const use = () => s.post(`/api/staff/grants/${grant.id}/use`);
    const unuse = () => s.post(`/api/staff/grants/${grant.id}/unuse`);
    const card = async () => (await view(sale.customerId)).card;

    const used = ok(await use()).customer.card;
    assert.deepEqual(used.available, []);
    assert.deepEqual(used.used.map(g => [g.id, g.usedAt]), [[grant.id, ctx.now()]]);
    refused(await use(), 409, 'problem');                 // a free service is used once

    ctx.tick(9 * MIN);
    const undone = ok(await unuse()).customer.card;
    assert.deepEqual(undone.available.map(g => g.id), [grant.id]);
    assert.deepEqual(undone.used, []);
    refused(await unuse(), 409, 'problem');               // nothing to undo

    ok(await use());
    ctx.tick(11 * MIN);
    refused(await unuse(), 409, 'problem');               // too late to undo
    assert.deepEqual((await card()).used.map(g => g.id), [grant.id]);
    refused(await s.post('/api/staff/grants/999999/use'), 409, 'problem');

    // the customer sees it as used, and cannot mark or unmark anything themselves
    const friend = await ctx.customer('5550000201', '0201');
    const me = ok(await friend.get('/api/me'));
    assert.deepEqual(me.card.available, []);
    assert.deepEqual(me.card.used.map(g => g.name), ['Tyre rotation']);
    refused(await friend.post(`/api/staff/grants/${grant.id}/unuse`), 401, 'staff-signed-out');
    refused(await friend.post(`/api/staff/grants/${grant.id}/use`), 401, 'staff-signed-out');
  });

  test('a breakdown shared by a customer reaches the staff list with phone and plate, is stored once in ten minutes, and can be marked seen', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const list = async () => ok(await s.get('/api/staff/breakdowns')).items;
    const unseen = async () => ok(await s.get('/api/staff/status')).breakdownsUnseen;
    const listedAtStart = (await list()).length, unseenAtStart = await unseen();

    const [regular] = await find(s, 'DM0001');
    const [other] = await find(s, 'DM0002');
    const driver = await ctx.customer('5550000101', '0001');
    const post = body => driver.post('/api/me/breakdown', body);

    // what the phone sends is checked before anything is stored
    assert.equal(refused(await post({ lat: 31.33 }), 400, 'invalid').field, 'lat');
    refused(await post({ lat: 131, lng: 75.58 }), 400, 'invalid');
    refused(await post({ lat: 31.33, lng: 75.58, vehicleId: other.vehicles[0].id }), 400, 'invalid');
    refused(await post({ lat: 31.33, lng: 75.58, customerId: other.customerId }), 400, 'invalid');
    refused(await post({ lat: 31.33, lng: 75.58, phone: '5550000102' }), 400, 'invalid');
    assert.equal((await list()).length, listedAtStart);

    // on the road near the second shop
    const sent = ok(await post({ lat: 31.3312345, lng: 75.5812345, accuracyM: 12.4, vehicleId: regular.vehicles[0].id }));
    assert.equal(sent.shared, true);
    assert.equal(sent.repeat, false);
    assert.deepEqual(sent.shop, { id: 'jalandhar', name: 'Test Tyre House, Jalandhar', phone: '+918300000002' }, 'the nearest shop, not the first one');
    assert.ok(sent.km >= 0 && sent.km < 5, `about a kilometre away, got ${sent.km}`);

    let items = await list();
    assert.equal(items.length, listedAtStart + 1);
    const mine = items[0];
    assert.equal(mine.phone, '+915550000101');
    assert.equal(mine.regNo, 'PB00DM0001');
    assert.equal(mine.customerId, regular.customerId);
    assert.equal(mine.vehicleId, regular.vehicles[0].id, 'and the vehicle, so the staff page can open the customer on it');
    assert.equal(mine.lat, 31.33123, 'kept to about a metre, nothing finer');
    assert.equal(mine.lng, 75.58123);
    assert.equal(mine.accuracyM, 12);
    assert.equal(mine.shopId, 'jalandhar');
    assert.equal(mine.at, ctx.now());
    assert.equal(mine.seenAt, null);
    assert.equal(await unseen(), unseenAtStart + 1);

    // a second tap five minutes later: the first one stands, and the customer is still told whom to call
    ctx.tick(5 * MIN);
    const again = ok(await post({ lat: 31.34, lng: 75.59 }));
    assert.equal(again.repeat, true);
    assert.equal(again.shared, false);
    assert.equal(again.shop.phone, '+918300000002');
    assert.equal((await list()).length, listedAtStart + 1);
    assert.equal(await unseen(), unseenAtStart + 1);

    // after the ten minutes a new one is stored, here with location refused on the phone
    ctx.tick(5 * MIN + SEC);
    const later = ok(await post({}));
    assert.equal(later.repeat, false);
    assert.equal(later.shared, false);
    assert.ok(later.shop.phone, 'still told whom to call');
    items = await list();
    assert.equal(items.length, listedAtStart + 2);
    assert.equal(items[0].phone, '+915550000101');
    assert.equal(items[0].lat, null);
    assert.equal(items[0].vehicleId, null, 'the phone named no vehicle this time');
    assert.equal(items[0].regNo, null);

    // marked seen once; tapping again does not move the time
    ok(await s.post(`/api/staff/breakdowns/${mine.id}/seen`));
    const seenAt = ctx.now();
    ctx.tick(MIN);
    ok(await s.post(`/api/staff/breakdowns/${mine.id}/seen`));
    items = await list();
    assert.equal(items.find(i => i.id === mine.id).seenAt, seenAt);
    assert.equal(items[0].seenAt, null);
    assert.equal(await unseen(), unseenAtStart + 1);
  });

  test('a location that arrives a few minutes after the first tap is added to that breakdown, and staff see it as new again', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const list = async () => ok(await s.get('/api/staff/breakdowns')).items;
    const unseen = async () => ok(await s.get('/api/staff/status')).breakdownsUnseen;
    const listedAtStart = (await list()).length, unseenAtStart = await unseen();
    const [regular] = await find(s, 'DM0001');
    const vehicleId = regular.vehicles[0].id;
    const driver = await ctx.customer('5550000101', '0001');
    const post = body => driver.post('/api/me/breakdown', body);

    // the first tap goes out before the phone has found where it is
    const first = ok(await post({ vehicleId }));
    assert.equal(first.shared, false);
    assert.equal(first.repeat, false);
    assert.equal(first.km, null);
    assert.equal(first.shop.id, 'ludhiana', 'with nothing to measure from, the main shop');
    const firstAt = ctx.now();
    let items = await list();
    assert.equal(items.length, listedAtStart + 1);
    const row = items[0];
    assert.deepEqual([row.lat, row.lng, row.accuracyM, row.shopId, row.vehicleId, row.seenAt], [null, null, null, 'ludhiana', vehicleId, null]);
    ok(await s.post(`/api/staff/breakdowns/${row.id}/seen`));   // staff notice it and ring the customer
    assert.equal(await unseen(), unseenAtStart);

    // another tap with still no location is only a repeat: nothing is stored and nothing changes
    ctx.tick(3 * MIN);
    const blind = ok(await post({ vehicleId }));
    assert.equal(blind.repeat, true);
    assert.equal(blind.shared, false);
    assert.deepEqual(await list(), items.map(i => (i.id === row.id ? { ...i, seenAt: firstAt } : i)));

    // then the phone finds itself, on the road near the second shop
    ctx.tick(MIN);
    const located = ok(await post({ lat: 31.3312345, lng: 75.5812345, accuracyM: 12.4 }));
    assert.equal(located.shared, true, 'the customer is told the location went through');
    assert.equal(located.repeat, false);
    assert.deepEqual(located.shop, { id: 'jalandhar', name: 'Test Tyre House, Jalandhar', phone: '+918300000002' });
    assert.ok(located.km >= 0 && located.km < 5, `about a kilometre away, got ${located.km}`);
    items = await list();
    assert.equal(items.length, listedAtStart + 1, 'it is the same breakdown, not a second one');
    assert.deepEqual(items[0], { ...row, lat: 31.33123, lng: 75.58123, accuracyM: 12, shopId: 'jalandhar', seenAt: null }, 'the location is on the first row, which counts as unseen again');
    assert.equal(items[0].at, firstAt);
    assert.equal(await unseen(), unseenAtStart + 1);

    // once a location is on record, further taps inside the ten minutes change nothing
    ctx.tick(MIN);
    const third = ok(await post({ lat: 30.91, lng: 75.85 }));
    assert.equal(third.repeat, true);
    assert.equal(third.shared, false);
    assert.deepEqual(await list(), items);

    // ten minutes after the first tap, a tap is a new breakdown
    ctx.tick(5 * MIN + SEC);
    const fresh = ok(await post({ lat: 30.91, lng: 75.85 }));
    assert.equal(fresh.repeat, false);
    assert.equal(fresh.shared, true);
    items = await list();
    assert.equal(items.length, listedAtStart + 2);
    assert.deepEqual([items[0].lat, items[0].shopId, items[1].lat, items[1].shopId], [30.91, 'ludhiana', 31.33123, 'jalandhar']);
  });

  test('a late location is added only to the customer\'s own breakdown, and only to one that had none', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const list = async () => ok(await s.get('/api/staff/breakdowns')).items;
    const one = await ctx.customer('5550000101', '0001');
    const two = await ctx.customer('5550000105', '0005');

    ok(await one.post('/api/me/breakdown', {}));                                   // no location yet
    ctx.tick(MIN);
    const other = ok(await two.post('/api/me/breakdown', { lat: 31.33, lng: 75.58 }));   // another customer, located at once
    assert.equal(other.repeat, false);
    const before = await list();
    assert.deepEqual(before.slice(0, 2).map(i => [i.phone, i.lat]), [['+915550000105', 31.33], ['+915550000101', null]]);

    ctx.tick(MIN);
    const repeat = ok(await two.post('/api/me/breakdown', { lat: 30.91, lng: 75.85 }));
    assert.equal(repeat.repeat, true, 'the second customer already shared a location: this is a repeat');
    assert.equal(repeat.shared, false);
    assert.deepEqual(await list(), before, 'and it did not land on the first customer\'s breakdown');
  });

  test('a new customer registered just after another was deleted still gets their breakdown through', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const list = async () => ok(await s.get('/api/staff/breakdowns')).items;
    const limits = () => ctx.app.db.q("SELECT key FROM throttle WHERE key LIKE 'bd:%' ORDER BY key").all().map(r => r.key);

    const first = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000401', regNo: 'PB00TS0401' })));
    const a = await ctx.customer('5550000401', '0401');
    assert.equal(ok(await a.post('/api/me/breakdown', { lat: 30.9, lng: 75.85 })).repeat, false);
    assert.deepEqual(limits(), [`bd:day:${first.customerId}`, `bd:gap:${first.customerId}`], 'the ten-minute and daily limits are counted against the customer');
    ok(await s.post(`/api/staff/customers/${first.customerId}/delete`, { last4: '0401' }));
    assert.deepEqual(limits(), [], 'and go when the customer is deleted');

    ctx.tick(2 * MIN);
    const second = ok(await s.post('/api/staff/sales', saleBody({ phone: '5550000402', regNo: 'PB00TS0402' })));
    assert.ok(second.customerId > first.customerId, `the deleted customer had id ${first.customerId}; it is not handed to the next one (got ${second.customerId})`);
    const b = await ctx.customer('5550000402', '0402');
    const sent = ok(await b.post('/api/me/breakdown', { lat: 30.91, lng: 75.86 }));
    assert.equal(sent.repeat, false, 'this customer has never asked for help before');
    assert.equal(sent.shared, true);
    assert.ok((await list()).some(i => i.phone === '+915550000402' && i.lat === 30.91), 'staff see where the new customer is');
  });

  test('the QR code is an SVG image for signed-in staff only, and a sale\'s code leads to that sale\'s passport', async t => {
    const ctx = await boot(t);
    refused(await ctx.client().get('/api/staff/qr'), 401, 'staff-signed-out');
    const s = await ctx.staff();
    const pattern = svg => / d="([^"]+)"/.exec(svg)[1];

    const plain = await s.get('/api/staff/qr');
    assert.equal(plain.status, 200);
    assert.match(plain.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(plain.headers.get('cache-control'), 'no-store');
    assert.match(plain.text, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(!/<script|\son\w+=|href=/i.test(plain.text), 'nothing active inside the image');
    assert.equal(pattern(plain.text), pattern(qrSvg(`${ctx.base}/passport/`)));

    const sale = ok(await s.post('/api/staff/sales', saleBody()));
    const forSale = await s.get(`/api/staff/qr?sale=${sale.saleId}`);
    assert.equal(forSale.status, 200);
    assert.match(forSale.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(pattern(forSale.text), pattern(qrSvg(sale.passportUrl)), 'the code holds this sale\'s passport link');
    assert.notEqual(pattern(forSale.text), pattern(plain.text));
    assert.ok(!forSale.text.includes(sale.passportUrl.split('#s=')[1]), 'the token appears only as the pattern');

    refused(await s.get('/api/staff/qr?sale=999999'), 404, 'not-found');
    refused(await s.get('/api/staff/qr?sale=abc'), 404, 'not-found');
    refused(await ctx.client().get(`/api/staff/qr?sale=${sale.saleId}`), 401, 'staff-signed-out');
  });

  test('a customer paused after three wrong vehicle tries gets in by scanning the QR code staff show them, which also lifts the pause', async t => {
    const ctx = await boot(t);
    const s = await ctx.staff();
    const phone = '5550000199';
    const sale = ok(await s.post('/api/staff/sales', saleBody({ phone })));
    const token = sale.passportUrl.split('#s=')[1];      // what the QR code on the staff screen carries
    const [regular] = await find(s, 'DM0001');
    const otherToken = ok(await s.get(`/api/staff/customers/${regular.customerId}`)).customer.vehicles[0].current.token;

    const mobile = ctx.client();
    const code = ok(await mobile.post('/api/auth/request', { phone })).demo.code;
    const verify = extra => mobile.post('/api/auth/verify', { phone, code, ...extra });
    assert.equal(refused(await verify({ plate: '9999' }), 400, 'bad-plate').left, 2);
    assert.equal(refused(await verify({ plate: '9998' }), 400, 'bad-plate').left, 1);
    const paused = refused(await verify({ plate: '9997' }), 429, 'ask-counter');
    assert.match(paused.message, /QR code/, 'the customer is told what will let them in');
    assert.match(paused.message, /counter/);

    // paused: the right plate no longer works, and neither does the QR code from somebody else's bill
    refused(await verify({ plate: '0199' }), 429, 'ask-counter');
    refused(await verify({ sale: otherToken }), 429, 'ask-counter');
    refused(await verify({ sale: 'A'.repeat(22) }), 429, 'ask-counter');
    assert.equal(ok(await mobile.get('/api/me')).signedIn, false);

    // the QR code for their own sale does, with the code they already hold: the pause did not cancel it
    const done = ok(await verify({ sale: token }), 'sign-in with the QR code from the staff screen');
    assert.equal(done.focusVehicleId, sale.vehicleId);
    const me = ok(await mobile.get('/api/me'));
    assert.equal(me.hasPassport, true);
    assert.deepEqual(me.vehicles.map(v => v.regNo), ['PB00TS0199']);

    // and the pause is over: on another day the plate is enough again
    ctx.tick(DAY - HOUR);                                // still inside the 24 hours the pause would have lasted
    const next = await ctx.customer(phone, '0199');
    assert.equal(ok(await next.get('/api/me')).hasPassport, true);
  });
});

/* ---------- demo and live ---------- */

describe('with no keys set', () => {
  test('the server runs as a demo, says so to the pages, and holds only made-up sample customers', async t => {
    const ctx = await boot(t);
    const pub = ok(await ctx.client().get('/api/public/config'));
    assert.equal(pub.mode, 'demo');
    assert.equal(pub.signIn, 'demo');
    assert.ok(pub.demo.samples.length >= 1);

    const s = ctx.client();
    ok(await signIn(s, pub.demo.staffPin), 'the demo PIN shown on the demo sign-in screen');
    const status = ok(await s.get('/api/staff/status'));
    assert.equal(status.mode, 'demo', 'the staff page is told it is a demo');
    const everyone = await find(s, 'PB00');
    assert.equal(everyone.length, status.database.customers, 'every sample customer has a PB00 plate (no such RTO office)');
    for (const r of everyone) assert.match(r.phone, /^\+91555\d{7}$/, 'sample numbers start 555, which no real mobile does');
  });

  test('a demo nobody asked for answers only on this computer: under any other address the API and the stop link say 503 and show nothing', async t => {
    const ctx = await boot(t);                           // no keys and no PASSPORT_MODE: a demo because nothing is set up
    const s = await ctx.staff();
    const port = new URL(ctx.base).port;
    const [regular] = await find(s, 'DM0001');
    const reminders = async () => ok(await s.get(`/api/staff/customers/${regular.customerId}`)).customer.reminders.state;
    const stopToken = ctx.app.db.q('SELECT stop_token AS t FROM customers WHERE id = ?').get(regular.customerId).t;
    const staffCookie = `hta_s=${s.jar.get('hta_s')}`;
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const json = { 'content-type': 'application/json', 'x-hta': '1' };
    assert.equal(await reminders(), 'yes');

    // what a tunnel, a proxy on the same machine or a phone on the shop Wi-Fi would send as the Host
    const elsewhere = ['passport.example.com', `passport.example.com:${port}`, '192.168.1.20:8080', '10.0.0.5', 'localhost.example.com', `127.0.0.1.example.com:${port}`, 'notlocalhost', '[2001:db8::1]:8080'];
    for (const host of elsewhere) {
      const asked = [
        await raw(ctx.base, 'GET', '/api/public/config', { host }),
        await raw(ctx.base, 'GET', '/api/me', { host }),
        await raw(ctx.base, 'GET', '/api/staff/status', { host, cookie: staffCookie }),
        await raw(ctx.base, 'GET', `/api/staff/customers/${regular.customerId}`, { host, cookie: staffCookie }),
        await raw(ctx.base, 'POST', '/api/staff/login', { host, ...json }, JSON.stringify({ pin: ctx.app.cfg.staffPin })),
        await raw(ctx.base, 'POST', '/api/auth/request', { host, ...json }, JSON.stringify({ phone: '5550000101' })),
        await raw(ctx.base, 'GET', '/api/nothing-here', { host }),
        await raw(ctx.base, 'GET', `/stop/${stopToken}`, { host }),
        await raw(ctx.base, 'POST', '/stop', { host, ...form }, `t=${stopToken}`),
      ];
      for (const res of asked) {
        const text = res.body.toString();
        assert.equal(res.status, 503, `Host: ${host}`);
        assert.equal(JSON.parse(text).error.code, 'not-set-up');
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['set-cookie'], undefined, 'no session is handed out');
        assert.ok(!text.includes(ctx.app.cfg.staffPin) && !text.includes('555000') && !text.includes('PB00'), `Host: ${host}: no demo PIN and no sample customer`);
      }
      // the pages themselves still load; it is only what they would ask the server that is closed
      assert.equal((await raw(ctx.base, 'GET', '/', { host })).status, 200);
      assert.equal((await raw(ctx.base, 'GET', '/staff/', { host })).status, 200);
    }
    assert.equal(await reminders(), 'yes', 'the stop button pressed under another address stopped nothing');

    // this computer, by any of its names, with or without a port
    for (const host of ['localhost', `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port}`, '[::1]', `[::1]:${port}`, `LOCALHOST:${port}`]) {
      const res = await raw(ctx.base, 'GET', '/api/public/config', { host });
      assert.equal(res.status, 200, `Host: ${host}`);
      assert.equal(JSON.parse(res.body.toString()).mode, 'demo');
      assert.equal((await raw(ctx.base, 'GET', `/stop/${stopToken}`, { host })).status, 200, `Host: ${host}`);
    }
    assert.equal((await raw(ctx.base, 'POST', '/stop', { host: `localhost:${port}`, ...form }, `t=${stopToken}`)).status, 200);
    assert.equal(await reminders(), 'stopped', 'the same button on this computer does stop them');
  });

  test('a demo asked for by name with PASSPORT_MODE=demo answers under any address', async t => {
    const ctx = await boot(t, { env: { ...DEMO_ENV, PASSPORT_MODE: 'demo' } });
    for (const host of ['passport.example.com', '192.168.1.20:8080', 'localhost']) {
      const res = await raw(ctx.base, 'GET', '/api/public/config', { host });
      assert.equal(res.status, 200, `Host: ${host}`);
      const cfg = JSON.parse(res.body.toString());
      assert.equal(cfg.mode, 'demo');
      assert.equal(cfg.demo.staffPin, ctx.app.cfg.staffPin, 'a demo that is meant to be public shows its PIN');
    }
    const signedIn = await raw(ctx.base, 'POST', '/api/staff/login', { host: 'passport.example.com', 'content-type': 'application/json', 'x-hta': '1' }, JSON.stringify({ pin: ctx.app.cfg.staffPin }));
    assert.equal(signedIn.status, 200);
  });
});

describe('on a live site', () => {
  test('there are no sample customers, no demo PIN and nothing marked as a demo', async t => {
    const ctx = await boot(t, { env: liveEnv(tmpDataDir()), sms: fakeSms() });
    const pub = await ctx.client().get('/api/public/config');
    const cfg = ok(pub);
    assert.equal(cfg.mode, 'live');
    assert.equal(cfg.demo, undefined);
    assert.ok(!pub.text.includes(LIVE_PIN) && !pub.text.includes('5550000') && !pub.text.includes('PB00DM'));

    refused(await signIn(ctx.client(), '246810'), 401, 'wrong-pin');       // the demo PIN opens nothing
    const s = await ctx.staff();
    const status = ok(await s.get('/api/staff/status'));
    assert.equal(status.mode, 'live');
    assert.equal(status.database.customers, 0);
    assert.equal(status.breakdownsUnseen, 0);
    assert.deepEqual(await find(s, 'PB00'), []);
    assert.deepEqual(await find(s, '5550'), []);
    assert.deepEqual(ok(await s.get('/api/staff/due')).items, []);
    assert.deepEqual(ok(await s.get('/api/staff/breakdowns')).items, []);
  });

  test('a sale needs a real mobile number, and links are built on the configured address whatever the request says', async t => {
    const ctx = await boot(t, { env: liveEnv(tmpDataDir()), sms: fakeSms() });
    const s = await ctx.staff();
    assert.equal(refused(await s.post('/api/staff/sales', saleBody({ phone: '5550000101' })), 400, 'invalid').field, 'phone');
    assert.equal(ok(await s.get('/api/staff/status')).database.customers, 0);

    const done = ok(await s.post('/api/staff/sales', saleBody({ phone: '+91 98765 00001', regNo: 'PB10HT2005', amount: 21400 })));
    assert.ok(done.passportUrl.startsWith('http://localhost:1/passport/#s='), done.passportUrl);
    assert.equal(done.customer.phone, '+919876500001');
    assert.equal(done.customer.vehicles[0].current.amountPaise, 2140000);
    assert.ok(done.customer.referral.link.startsWith('http://localhost:1/passport/?ref='));

    const spoofed = await raw(ctx.base, 'GET', `/api/staff/customers/${done.customerId}`, { host: 'evil.example', cookie: `hta_s=${s.jar.get('hta_s')}` });
    assert.equal(spoofed.status, 200);
    assert.ok(!spoofed.body.toString().includes('evil.example'), 'a forged Host header does not end up in links');
    assert.ok(JSON.parse(spoofed.body.toString()).customer.referral.link.startsWith('http://localhost:1/passport/?ref='));
  });

  test('a prepared reminder stays "ready" until a person at the shop does something, and the server itself sends nothing', async t => {
    const sms = fakeSms();
    const ctx = await boot(t, { env: liveEnv(tmpDataDir()), sms });
    const s = await ctx.staff();
    const due = async () => ok(await s.get('/api/staff/due')).items;
    assert.deepEqual(await due(), []);

    // fitted long enough ago that replacement falls due in the next few weeks (45,000 km at 1,000 km a month)
    const fittedOn = new Date(T0 - 1360 * 24 * HOUR).toISOString().slice(0, 10);
    const done = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500004', regNo: 'PB10HT2007', fittedOn, remindersOk: true })));
    const items = await due();
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.customerId, done.customerId);
    assert.equal(item.type, 'replacement');
    assert.ok(item.daysLeft > 0 && item.daysLeft <= 30, `due in ${item.daysLeft} days`);
    assert.equal(item.status, 'ready');
    assert.equal(item.statusAt, null);
    assert.ok(item.message.includes('http://localhost:1/stop/'), 'the stop link is on the public address');
    assert.ok(item.waUrl.startsWith('https://wa.me/919876500004?text='));

    ok(await s.post('/api/staff/reminders', { key: item.key, status: 'opened' }));
    assert.equal((await due())[0].status, 'opened', 'opened in WhatsApp is recorded as opened, not as sent');
    assert.deepEqual(sms.sent, [], 'registering a sale and preparing a reminder sent no text message');
  });

  // which files in a live data folder (the database, its write-ahead log and its index; not the backups folder) hold this text
  const filesHolding = (dir, text) => fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isFile() && fs.readFileSync(path.join(dir, name)).includes(text));
  const walSize = dir => fs.statSync(path.join(dir, 'passport.sqlite-wal')).size;

  test('once a customer is deleted, or a sale typed with the wrong number is removed, their numbers are in no database file: the write-ahead log is emptied as well', async t => {
    const dir = tmpDataDir();
    const ctx = await boot(t, { env: liveEnv(dir), sms: fakeSms() });
    const s = await ctx.staff();

    const leaving = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500021', regNo: 'PB10HT3021' })));
    assert.ok(walSize(dir) > 0, 'a new sale is written to the write-ahead log first');
    assert.ok(filesHolding(dir, '9876500021').length > 0 && filesHolding(dir, 'PB10HT3021').length > 0, 'the numbers are on disk, in plain text');
    ctx.tick(MIN);
    ok(await s.post(`/api/staff/customers/${leaving.customerId}/delete`, { last4: '0021' }));
    assert.equal(walSize(dir), 0, 'the write-ahead log is emptied by the delete');
    assert.deepEqual(filesHolding(dir, '9876500021'), [], 'the phone number is in no file');
    assert.deepEqual(filesHolding(dir, 'PB10HT3021'), [], 'nor is the vehicle number');

    const mistyped = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500022', regNo: 'PB10HT3022' })));
    assert.ok(filesHolding(dir, '9876500022').length > 0);
    ctx.tick(MIN);
    assert.equal(ok(await s.post(`/api/staff/sales/${mistyped.saleId}/void`)).customer, null);
    assert.equal(walSize(dir), 0, 'and by removing a sale');
    assert.deepEqual(filesHolding(dir, '9876500022'), []);
    assert.deepEqual(filesHolding(dir, 'PB10HT3022'), []);
  });

  test('an invited friend who deletes their data before ever buying leaves their number in no database file either', async t => {
    const dir = tmpDataDir(), sms = fakeSms();
    const ctx = await boot(t, { env: liveEnv(dir), sms });
    const s = await ctx.staff();
    const referrer = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500041', regNo: 'PB10HT3041' })));
    const code = referrer.customer.referral.code;

    // the friend opens the invitation link, signs in, and then thinks better of it
    const friend = ctx.client();
    ok(await friend.post('/api/auth/request', { phone: '9876500042', ref: code }));
    ok(await friend.post('/api/auth/verify', { phone: '9876500042', code: sms.sent[0].code, ref: code }));
    assert.equal(ok(await friend.get('/api/me')).invited, true);
    assert.deepEqual(tablesMentioning(ctx.app.db, '9876500042').sort(), ['referrals', 'sessions'], 'the invitation and the sign-in are kept under the number');
    assert.ok(filesHolding(dir, '9876500042').length > 0);
    ctx.tick(MIN);
    ok(await friend.post('/api/me/delete', { confirm: 'DELETE' }));
    assert.equal(ok(await friend.get('/api/me')).signedIn, false);
    assert.deepEqual(tablesMentioning(ctx.app.db, '9876500042'), [], 'no table holds the number any more');
    assert.deepEqual(filesHolding(dir, '9876500042'), [], 'and no database file should either');
  });

  test('housekeeping deletes a customer nobody has seen for seven years, but not one whose old bill staff typed in today', async t => {
    const dir = tmpDataDir();
    const ctx = await boot(t, { env: liveEnv(dir), sms: fakeSms() });
    let s = await ctx.staff();
    const idle = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500011', regNo: 'PB10HT3011' })));
    const back = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500012', regNo: 'PB10HT3012' })));
    assert.deepEqual(ctx.app.housekeeping(), { expired: 0 });

    // Seven years and a month later neither has been in since. One of them comes back, with an old bill from
    // another shop's fitting that staff add to the record: dated well before the cutoff, but typed in today.
    const YEARS = SETTINGS.privacy.deleteAfterInactiveYears;
    ctx.tick(Math.round((YEARS * 365.25 + 30) * DAY));
    s = await ctx.staff();
    const today = ok(await s.get('/api/staff/status')).today;
    const oldBill = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500012', regNo: 'PB10HT3013', fittedOn: dayPlus(today, -3000) })));
    assert.equal(oldBill.customerId, back.customerId);
    assert.ok(dayPlus(today, -3000) < dayPlus(today, -Math.ceil(YEARS * 365.25)), 'the bill itself is older than seven years');

    assert.deepEqual(ctx.app.housekeeping(), { expired: 1 }, 'one customer is past keeping, not two');
    refused(await s.get(`/api/staff/customers/${idle.customerId}`), 404, 'not-found');
    assert.deepEqual(await find(s, 'HT3011'), []);
    assert.deepEqual(tablesMentioning(ctx.app.db, '9876500011'), []);
    assert.deepEqual(filesHolding(dir, '9876500011'), [], 'and nothing of the one who went is left in the database files');
    const kept = ok(await s.get(`/api/staff/customers/${back.customerId}`)).customer;
    assert.deepEqual(kept.vehicles.map(v => v.regNo).sort(), ['PB10HT3012', 'PB10HT3013'], 'the customer whose record was touched today is kept, whatever the dates on it');

    // it is the typing that counted, and it counts for seven years, not for ever
    ctx.tick(Math.round((YEARS * 365.25 - 30) * DAY));
    assert.deepEqual(ctx.app.housekeeping(), { expired: 0 }, 'a month short of seven years after the record was last touched');
    ctx.tick(60 * DAY);
    assert.deepEqual(ctx.app.housekeeping(), { expired: 1 });
    assert.deepEqual(tablesMentioning(ctx.app.db, '9876500012'), []);
  });

  test('with referrals switched off in the settings, an invitation accepted earlier earns nobody anything when the friend buys', async t => {
    const dir = tmpDataDir(), clock = { ms: T0 }, sms = fakeSms();
    const on = await boot(t, { env: liveEnv(dir), sms, clock });
    let s = await on.staff();
    const referrer = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500031', regNo: 'PB10HT3031' })));
    const code = referrer.customer.referral.code;
    // the friend opens the invitation link and signs in, while referrals are still on
    const friend = on.client();
    ok(await friend.post('/api/auth/request', { phone: '9876500032', ref: code }));
    assert.equal(sms.sent.length, 1, 'an invited number is sent a code');
    ok(await friend.post('/api/auth/verify', { phone: '9876500032', code: sms.sent[0].code, ref: code }));
    assert.equal(ok(await friend.get('/api/me')).invited, true);
    await on.close();

    // the owner sets rewards.referral.maxPerYear to 0 and restarts
    clock.ms += DAY;
    const off = await boot(t, { env: liveEnv(dir), sms, clock, tweak: settings => { settings.rewards.referral.maxPerYear = 0; } });
    s = await off.staff();
    assert.equal(ok(await s.get('/api/staff/status')).referralOn, false);
    assert.equal(ok(await off.client().get('/api/public/config')).referral, null);
    const bought = ok(await s.post('/api/staff/sales', saleBody({ phone: '9876500032', regNo: 'PB10HT3032' })));
    assert.equal(bought.referral, null, 'the sale earns no referral reward');
    assert.deepEqual(bought.customer.card.available, [], 'the friend has no free service');
    assert.equal(bought.customer.referral, null);
    assert.deepEqual(ok(await s.get(`/api/staff/customers/${referrer.customerId}`)).customer.card.available, [], 'and neither has the customer who invited them');
    assert.equal(off.app.db.q("SELECT COUNT(*) AS n FROM grants WHERE source = 'referral'").get().n, 0);
  });

  test('on an https address the staff cookies are marked Secure and pages ask browsers to stay on https', async t => {
    const ctx = await boot(t, { env: liveEnv(tmpDataDir(), { PUBLIC_BASE_URL: 'https://passport.example.test' }), sms: fakeSms() });
    const res = await signIn(ctx.client(), LIVE_PIN);
    ok(res);
    for (const name of ['hta_s', 'hta_d']) {
      const line = res.setCookie.find(c => c.startsWith(name + '='));
      assert.match(line, /;\s*Secure/i, `${name} is Secure`);
      assert.match(line, /;\s*HttpOnly/i);
      assert.match(line, /;\s*SameSite=Strict/i);
    }
    assert.match((await ctx.client().get('/staff/')).headers.get('strict-transport-security') || '', /max-age=\d{6,}/);
  });

  test('restarting the server does not lift a PIN lock', async t => {
    const dir = tmpDataDir(), clock = { ms: T0 };
    const first = await boot(t, { env: liveEnv(dir), sms: fakeSms(), clock });
    const tries = [];
    for (let i = 0; i < PIN_TRIES; i++) tries.push(await signIn(first.client(), WRONG_PIN));
    assert.deepEqual(tries.map(r => r.status), untilLocked(PIN_TRIES));
    const lockSec = Number(tries[PIN_TRIES - 1].headers.get('retry-after'));
    assert.ok(lockSec >= 5 * 60);
    await first.close();

    const second = await boot(t, { env: liveEnv(dir), sms: fakeSms(), clock });
    refused(await signIn(second.client(), LIVE_PIN), 429, 'locked');
    second.tick(lockSec * SEC + SEC);
    ok(await signIn(second.client(), LIVE_PIN));
  });

  test('changing the staff PIN signs every device out and forgets remembered browsers; a plain restart does neither', async t => {
    const dir = tmpDataDir(), clock = { ms: T0 };
    const first = await boot(t, { env: liveEnv(dir), sms: fakeSms(), clock });
    const shop = await first.staff();
    const held = new Map(shop.jar);                       // what the shop tablet holds: its session and its device cookie
    assert.ok(held.get('hta_s') && held.get('hta_d'));
    const sale = ok(await shop.post('/api/staff/sales', saleBody({ phone: '9876500002', regNo: 'PB10HT2006' })));
    await first.close();
    const tabletOn = ctx => { const c = ctx.client(); for (const [k, v] of held) c.jar.set(k, v); return c; };

    // the same PIN after a restart: still signed in, and the customers are still there
    const restarted = await boot(t, { env: liveEnv(dir), sms: fakeSms(), clock });
    const still = tabletOn(restarted);
    assert.equal(ok(await still.get('/api/staff/status')).database.customers, 1);
    assert.equal(ok(await still.get(`/api/staff/customers/${sale.customerId}`)).customer.phone, '+919876500002');
    await restarted.close();

    // a new PIN
    const changed = await boot(t, { env: liveEnv(dir, { STAFF_PIN: NEW_PIN }), sms: fakeSms(), clock });
    const tablet = tabletOn(changed);
    refused(await tablet.get('/api/staff/status'), 401, 'staff-signed-out');
    refused(await tablet.post('/api/staff/sales', saleBody({ phone: '9876500003' })), 401, 'staff-signed-out');
    // The old PIN is now a wrong PIN. If the browser were still remembered this try would go on its own
    // counter; it is not, so it counts with everyone else's on this address, and one try fewer locks the address.
    refused(await signIn(tablet, LIVE_PIN), 401, 'wrong-pin');
    const stranger = changed.client();
    const tries = [];
    for (let i = 0; i < PIN_TRIES - 1; i++) tries.push(await signIn(stranger, WRONG_PIN));
    assert.deepEqual(tries.map(r => r.status), untilLocked(PIN_TRIES - 1));
    refused(await signIn(tablet, NEW_PIN), 429, 'locked');   // and the old device cookie no longer gets past a lock

    changed.tick(Number(tries[tries.length - 1].headers.get('retry-after')) * SEC + SEC);
    ok(await signIn(tablet, NEW_PIN));
    assert.equal(ok(await tablet.get('/api/staff/status')).database.customers, 1, 'the customers are untouched by a PIN change');
  });

  test('changing the staff PIN also lifts every lock-out left by wrong tries at the old one; a restart with the same PIN lifts none', async t => {
    const dir = tmpDataDir(), clock = { ms: T0 };
    const env = extra => liveEnv(dir, { TRUST_PROXY: '1', ...extra });
    const from = address => ({ 'x-forwarded-for': address });
    const first = await boot(t, { env: env(), sms: fakeSms(), clock });

    // Wrong PINs from five addresses, four each: no address is locked on its own, but together they lock the
    // site for every browser the shop has not used.
    const statuses = [];
    for (let n = 0; n < PIN_TRIES_ALL; n++) statuses.push((await signIn(first.client(), WRONG_PIN, from(`203.0.113.${1 + Math.floor(n / (PIN_TRIES - 1))}`))).status);
    assert.deepEqual(statuses, untilLocked(PIN_TRIES_ALL));
    refused(await signIn(first.client(), LIVE_PIN, from('192.0.2.77')), 429, 'locked');
    await first.close();

    const restarted = await boot(t, { env: env(), sms: fakeSms(), clock });
    refused(await signIn(restarted.client(), LIVE_PIN, from('192.0.2.77')), 429, 'locked');
    refused(await signIn(restarted.client(), LIVE_PIN, from('203.0.113.1')), 429, 'locked');
    await restarted.close();

    // the owner sets a new PIN: the shop must be able to sign in with it at once, from anywhere
    const changed = await boot(t, { env: env({ STAFF_PIN: NEW_PIN }), sms: fakeSms(), clock });
    assert.deepEqual(changed.app.db.q("SELECT key FROM throttle WHERE key LIKE 'pin:%'").all(), [], 'no count of wrong PINs is carried over');
    // an address that had used four of its five tries starts again from five
    assert.equal(refused(await signIn(changed.client(), LIVE_PIN, from('203.0.113.1')), 401, 'wrong-pin').left, PIN_TRIES - 1, 'the old PIN is simply a wrong PIN now');
    ok(await signIn(changed.client(), NEW_PIN, from('203.0.113.1')), 'the new PIN, from an address that was one try from its own lock');
    ok(await signIn(changed.client(), NEW_PIN, from('192.0.2.77')), 'and from one that was locked out with everyone else');
  });

  test('wrong PINs spread across many addresses lock sign-in for strangers everywhere, but not for the shop\'s own browser', async t => {
    const ctx = await boot(t, { env: liveEnv(tmpDataDir(), { TRUST_PROXY: '1' }), sms: fakeSms() });
    const from = address => ({ 'x-forwarded-for': address });
    const shop = ctx.client();
    ok(await signIn(shop, LIVE_PIN, from('198.51.100.10')));
    const tablet = ctx.client();
    tablet.jar.set('hta_d', shop.jar.get('hta_d'));

    // one try short of the limit from each address, from as many addresses as it takes to reach the limit for all
    const statuses = [];
    for (let n = 0; n < PIN_TRIES_ALL; n++) {
      const address = `203.0.113.${1 + Math.floor(n / (PIN_TRIES - 1))}`;
      statuses.push((await signIn(ctx.client(), WRONG_PIN, from(address))).status);
    }
    assert.deepEqual(statuses.slice(0, -1), Array(PIN_TRIES_ALL - 1).fill(401), 'no single address reached its own limit');
    assert.equal(statuses[PIN_TRIES_ALL - 1], 429, 'the last of them locks sign-in for everyone not yet known');
    refused(await signIn(ctx.client(), LIVE_PIN, from('192.0.2.77')), 429, 'locked');
    ok(await signIn(tablet, LIVE_PIN, from('198.51.100.10')), 'the shop\'s remembered browser');
  });

  test('behind a proxy, an attacker cannot dodge the PIN lock by adding made-up addresses to X-Forwarded-For', async t => {
    const ctx = await boot(t, { env: liveEnv(tmpDataDir(), { TRUST_PROXY: '1' }), sms: fakeSms() });
    const statuses = [];
    for (let i = 0; i < PIN_TRIES; i++) statuses.push((await signIn(ctx.client(), WRONG_PIN, { 'x-forwarded-for': `10.0.0.${i + 1}, 203.0.113.9` })).status);
    assert.deepEqual(statuses, untilLocked(PIN_TRIES));
    refused(await signIn(ctx.client(), LIVE_PIN, { 'x-forwarded-for': '10.9.9.9, 203.0.113.9' }), 429, 'locked');
    // someone on a different real address is not caught up in it
    ok(await signIn(ctx.client(), LIVE_PIN, { 'x-forwarded-for': '203.0.113.10' }));
  });
});

/* ---------- the site's own files ---------- */

describe('the files the server hands out', () => {
  let ctx, browser;
  before(async () => { ctx = await boot(null, { shipped: true }); browser = ctx.client(); });
  after(async () => { await ctx.close(); });

  const disk = rel => fs.readFileSync(path.join(ROOT, rel));
  const HTML = /^text\/html;\s*charset=utf-8$/i;
  const APP_PAGES = [['/passport/', 'passport/index.html'], ['/staff/', 'staff/index.html'], ['/privacy/', 'privacy/index.html'], ['/tyres/', 'tyres/index.html']];
  // a file the home page ships that is large enough to be asked for in pieces: the hero's first frame
  const VIDEO = '/assets/img/scenes/hero-film.webp';

  test('the home page, its stylesheet, script and logo, and the three new pages arrive byte for byte as they are on disk', async () => {
    const wanted = [
      ['/', 'index.html', HTML],
      ['/index.html', 'index.html', HTML],
      ['/css/styles.css', 'css/styles.css', /^text\/css;\s*charset=utf-8$/i],
      ['/js/main.js', 'js/main.js', /^(text|application)\/javascript;\s*charset=utf-8$/i],
      ['/assets/img/logo.png', 'assets/img/logo.png', /^image\/png$/],
      ...APP_PAGES.map(([url, rel]) => [url, rel, HTML]),
    ];
    for (const [url, rel, type] of wanted) {
      const res = await browser.get(url);
      assert.equal(res.status, 200, url);
      assert.match(res.headers.get('content-type'), type, url);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
      assert.ok(res.buf.equals(disk(rel)), `${url} is not the same bytes as ${rel}`);
    }
    // a query string (a cache-buster, a referral code) does not change which file is served
    assert.ok((await browser.get('/css/styles.css?v=2')).buf.equals(disk('css/styles.css')));
    assert.ok((await browser.get('/passport/?ref=ABCD2345')).buf.equals(disk('passport/index.html')));
  });

  test('every stylesheet, script, picture, font and film the site ships can be fetched', async () => {
    const files = [];
    const walk = rel => {
      for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${rel}/${entry.name}`); else files.push(`${rel}/${entry.name}`);
      }
    };
    ['css', 'js', 'assets'].forEach(walk);
    assert.ok(files.length > 20, `expected the site's assets, found ${files.length} files`);
    for (const rel of files) {
      const res = await browser.head('/' + rel.split('/').map(encodeURIComponent).join('/'));
      assert.equal(res.status, 200, rel);
      assert.equal(Number(res.headers.get('content-length')), fs.statSync(path.join(ROOT, rel)).size, rel);
      assert.ok(res.headers.get('content-type'), rel);
    }
  });

  test('everything the four pages link to on this site is served', async () => {
    const local = /^\/?[\w./-]+\.(css|js|png|jpe?g|webp|avif|svg|ico|woff2|mp4)$|^\/?(passport|staff|privacy)\/$|^\/$/;
    for (const [url, rel] of [['/', 'index.html'], ...APP_PAGES]) {
      const html = disk(rel).toString('utf8');
      const refs = new Set([...html.matchAll(/\s(?:src|href|srcset|poster|data-[a-z-]+)="([^"]+)"/g)].map(m => m[1]).filter(v => local.test(v)));
      assert.ok(refs.size >= 5, `${rel}: expected links to styles, scripts and pictures`);
      for (const ref of refs) {
        const target = new URL(ref, ctx.base + url);
        assert.equal((await browser.head(target.pathname)).status, 200, `${rel} links to ${ref}`);
      }
    }
  });

  test('/passport, /staff and /privacy without the slash redirect to the page, keeping the query', async () => {
    for (const p of ['/passport', '/staff', '/privacy']) {
      const res = await browser.get(p);
      assert.ok([301, 302, 307, 308].includes(res.status), `${p} answered ${res.status}`);
      assert.equal(res.headers.get('location'), p + '/');
    }
    assert.equal((await browser.get('/passport?ref=ABCD2345')).headers.get('location'), '/passport/?ref=ABCD2345');
  });

  test('server code, settings, data, tools and notes are never served, whatever shape the path takes', async () => {
    const hidden = [
      '/server/app.js', '/config/passport.json', '/package.json', '/.env', '/.env.example', '/data/passport.sqlite',
      '/node_modules/qrcode-generator/package.json', '/tools/make-sequence.sh', '/accessibility-audit.md',
      '/css/../server/app.js', '/css/%2e%2e/server/app.js', '/css/..%5cserver%5capp.js', '/assets/..%2f..%2fpackage.json',
      '/js/main.js::$DATA', '/js/main.js.',
      // more of the same family
      '/css/..\\server\\app.js', '/css/..%2fserver%2fapp.js', '/css/%252e%252e/server/app.js', '/assets/img/..%2f..%2f..%2fserver%2fapp.js',
      '/js/main.js%2e', '/js/main.js%20', '/js/main.js%00.png', '/js/main.js:stream', '/js/MAIN~1.JS', '/css/%E0%A4%A.css',
      '/js/nul.js', '/css/con.css', '/assets/aux.png',
      '//server/app.js', '/server/', '/package-lock.json', '/.gitignore', '/test/http-staff.test.js', '/server/config.js', '/server/seed.js',
    ];
    for (const p of hidden) {
      const res = await raw(ctx.base, 'GET', p);
      assert.equal(res.status, 404, `GET ${p}`);
      assert.ok(res.body.length < 200, `GET ${p} sent ${res.body.length} bytes`);
    }
    // the same through fetch, which tidies dot segments first, and with HEAD
    for (const p of hidden.slice(0, 15)) {
      assert.equal((await browser.get(p)).status, 404, `fetch ${p}`);
      assert.equal((await raw(ctx.base, 'HEAD', p)).status, 404, `HEAD ${p}`);
    }
    // the files this list protects really are there, so the 404s above mean something
    for (const rel of ['server/app.js', 'config/passport.json', 'package.json', '.env.example', 'tools/make-sequence.sh', 'node_modules/qrcode-generator/package.json']) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} exists on disk`);
    }
  });

  test('HEAD gives the same headers as GET and no body', async () => {
    for (const [url, rel] of [['/', 'index.html'], ['/css/styles.css', 'css/styles.css'], ['/staff/', 'staff/index.html'], [VIDEO, VIDEO.slice(1)]]) {
      const head = await browser.head(url), get = await browser.get(url);
      assert.equal(head.status, 200, url);
      assert.equal(head.buf.length, 0, url);
      assert.equal(Number(head.headers.get('content-length')), fs.statSync(path.join(ROOT, rel)).size, url);
      for (const name of ['content-type', 'etag', 'last-modified', 'cache-control', 'content-security-policy']) {
        assert.equal(head.headers.get(name), get.headers.get(name), `${url} ${name}`);
      }
    }
  });

  test('a picture can be fetched in byte ranges, and a range past the end is refused with 416', async () => {
    const film = disk(VIDEO.slice(1)), size = film.length;
    assert.equal((await browser.head(VIDEO)).headers.get('accept-ranges'), 'bytes');
    const ranges = [
      ['bytes=0-99', 0, 99],
      ['bytes=0-0', 0, 0],
      ['bytes=1000-1999', 1000, 1999],
      [`bytes=${size - 10}-`, size - 10, size - 1],
      ['bytes=-500', size - 500, size - 1],
      [`bytes=${size - 5}-${size + 1000}`, size - 5, size - 1],
    ];
    for (const [range, start, end] of ranges) {
      const res = await browser.get(VIDEO, { range });
      assert.equal(res.status, 206, range);
      assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${size}`, range);
      assert.equal(Number(res.headers.get('content-length')), end - start + 1, range);
      assert.equal(res.headers.get('content-type'), 'image/webp', range);
      assert.ok(res.buf.equals(film.subarray(start, end + 1)), `${range} returned the wrong bytes`);
    }
    for (const range of [`bytes=${size}-`, `bytes=${size + 100}-${size + 200}`, 'bytes=99999999999-']) {
      const res = await browser.get(VIDEO, { range });
      assert.equal(res.status, 416, range);
      assert.equal(res.headers.get('content-range'), `bytes */${size}`, range);
      assert.equal(res.buf.length, 0, range);
    }
    const whole = await browser.get(VIDEO);
    assert.equal(whole.status, 200);
    assert.ok(whole.buf.equals(film));
  });

  test('If-None-Match with the current ETag gives 304 and no body', async () => {
    for (const url of ['/css/styles.css', '/', '/passport/', '/assets/img/logo.png']) {
      const first = await browser.get(url);
      const etag = first.headers.get('etag');
      assert.ok(etag, `${url} has an ETag`);
      const again = await browser.get(url, { 'if-none-match': etag });
      assert.equal(again.status, 304, url);
      assert.equal(again.buf.length, 0, url);
      assert.equal(again.headers.get('etag'), etag, url);
      assert.equal((await browser.get(url, { 'if-none-match': '"something-else"' })).status, 200, url);
    }
  });

  test('the passport, staff and privacy pages forbid inline scripts and framing, and contain nothing their own policy would block', async () => {
    for (const [url] of APP_PAGES) {
      const res = await browser.get(url);
      const csp = res.headers.get('content-security-policy');
      assert.ok(csp, `${url} has a Content-Security-Policy`);
      assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), `${url}: ${csp}`);
      assert.match(csp, /(^|;)\s*default-src 'self'/, url);
      assert.match(csp, /(^|;)\s*script-src 'self'\s*(;|$)/, url);
      assert.match(csp, /(^|;)\s*frame-ancestors 'none'/, url);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', url);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);

      const html = res.text;
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        assert.match(m[1], /\ssrc="\/[^"]+"/, `${url}: every script comes from a file on this site`);
        assert.equal(m[2].trim(), '', `${url}: no inline script`);
      }
      assert.ok(!/<style\b/i.test(html), `${url}: no inline style block`);
      assert.ok(!/<[a-z][^>]*\sstyle\s*=/i.test(html), `${url}: no style attribute`);
      assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), `${url}: no inline event handler`);
      assert.ok(!/<(?:script|link|img|iframe)\b[^>]*\s(?:src|href)="https?:/i.test(html), `${url}: nothing loaded from another site`);
    }
  });

  test('the home page is not given a policy that would block the inline styles and scripts it has always used', async () => {
    const res = await browser.get('/');
    const inlineStyle = /<[a-z][^>]*\sstyle\s*=/i.test(res.text) || /<style\b/i.test(res.text);
    const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>\s*\S/i.test(res.text);
    const csp = res.headers.get('content-security-policy');
    // no policy at all is fine for the old page; a policy is fine only if it lets the page's own inline parts run
    if (csp && inlineStyle) assert.match(csp, /style-src[^;]*'unsafe-inline'/, 'index.html has inline styles this policy would block');
    if (csp && inlineScript) assert.match(csp, /script-src[^;]*'unsafe-inline'/, 'index.html has inline scripts this policy would block');
  });

  test('API answers are never cached: every /api response says cache-control no-store', async () => {
    const s = await ctx.staff();
    const answers = [
      ['public config', await browser.get('/api/public/config'), 200],
      ['a staff route without a session', await browser.get('/api/staff/status'), 401],
      ['an address that does not exist', await browser.get('/api/nothing-here'), 404],
      ['the wrong method', await browser.get('/api/staff/login'), 405],
      ['a refused form', await browser.post('/api/staff/login', { pin: 'x' }), 400],
      ['a staff route with a session', await s.get('/api/staff/status'), 200],
      ['a customer record', await lookup(s, 'PB00'), 200],
      ['the QR image', await s.get('/api/staff/qr'), 200],
      ['the signed-out passport', await browser.get('/api/me'), 200],
    ];
    for (const [what, res, status] of answers) {
      assert.equal(res.status, status, what);
      assert.equal(res.headers.get('cache-control'), 'no-store', what);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', what);
    }
  });

  test('the scripts the pages load never put a customer search in an address: the only thing after a ? on an API address is a sale\'s row number for its QR code', () => {
    const pageScripts = fs.readdirSync(path.join(ROOT, 'js')).filter(name => name.endsWith('.js'));
    assert.ok(pageScripts.includes('staff.js') && pageScripts.includes('passport.js'));
    let apiCalls = 0;
    for (const name of pageScripts) {
      const source = disk(`js/${name}`).toString('utf8');
      apiCalls += (source.match(/\/api\//g) || []).length;
      assert.ok(!source.includes('/api/staff/lookup?') && !/\/api\/staff\/lookup['"`]\s*\+/.test(source), `js/${name} builds a lookup address with the search in it`);
      for (const m of source.matchAll(/\/api\/[^\s'"`?]*\?[^\s'"`]*/g)) assert.match(m[0], /^\/api\/staff\/qr\?sale=\$\{[\w.]+\}$/, `js/${name}: ${m[0]}`);
    }
    assert.ok(apiCalls >= 20, `expected to find the pages' API calls, found ${apiCalls}`);
    assert.match(disk('js/staff.js').toString('utf8'), /\/api\/staff\/lookup['"`]\s*,\s*\{\s*q\b/, 'the staff page sends the search as { q } in the body');
  });

  test('a request that is not GET or HEAD to a file is answered 405 and the file is untouched', async () => {
    const beforeBytes = disk('css/styles.css');
    for (const [method, p] of [['POST', '/'], ['POST', '/index.html'], ['PUT', '/css/styles.css'], ['DELETE', '/assets/img/logo.png'], ['PATCH', '/js/main.js'], ['POST', '/staff/'], ['POST', '/server/app.js']]) {
      const res = await browser.request(method, p, { body: { x: 1 } });
      assert.equal(res.status, 405, `${method} ${p}`);
      assert.match(res.headers.get('allow') || '', /GET/, `${method} ${p}`);
    }
    assert.ok(disk('css/styles.css').equals(beforeBytes));
    assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'img', 'logo.png')));
  });
});
