'use strict';

/* Customer sign-in and sessions, tested over real HTTP against createApp().handler.

   Almost everything here runs against a LIVE configuration: a database file in a fresh folder under the
   system temp folder, a staff PIN, and a stand-in for the SMS provider that only writes down what it was
   asked to send. The clock is injected, so "a minute later" and "thirty days later" are instant and exact.
   Customers are set up the way they are in the shop: staff sign in with the PIN and register a sale.

   Run with:  node --disable-warning=ExperimentalWarning --test test/http-auth.test.js */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/app');
const { DEMO_PIN } = require('../server/config');
const { DEMO_SAMPLES } = require('../server/seed');

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 6, 6, 30);   // noon at the shop on 6 October 2026
const APP_SECRET = 'x'.repeat(40), STAFF_PIN = '48151623', LIVE_BASE = 'http://localhost:1';

// Live databases go in fresh folders under here. They are small and are left behind on purpose: nothing in
// this file deletes anything.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-http-auth-'));

/* ---------- made-up people ---------- */

let serial = 0;
// a number no test has used before, and a plate whose last four characters nobody else has
function person() {
  serial += 1;
  const phone = '98765' + String(serial).padStart(5, '0');
  return { phone, e164: '+91' + phone, regNo: 'PB10HT' + (1000 + serial), tail: String(1000 + serial) };
}
const WRONG_TAIL = '0000';                    // no plate above ends like this
const NOBODYS_REFERRAL_CODE = 'O0O0O0O0';     // well formed, but real codes never contain O or 0
const wrongCode = code => (code === '123456' ? '654321' : '123456');
// the name, value and attributes of one Set-Cookie line
function cookieParts(line) {
  const [pair, ...attrs] = line.split(';').map(x => x.trim());
  const at = pair.indexOf('=');
  return { name: pair.slice(0, at), value: pair.slice(at + 1), attrs: attrs.map(a => a.toLowerCase()) };
}

/* ---------- one running server ---------- */

async function start({ demo = false, env = {}, fakeSms = true, at = START } = {}) {
  const w = { t: at, logs: [], texts: [] };
  // every text the server asks for is written down here; `refuse` makes the provider say no
  w.sms = {
    ready: true,
    refuse: false,
    async sendOtp(phone, code) {
      const ok = !w.sms.refuse;
      w.texts.push({ phone, code, ok });
      return ok ? { ok: true } : { ok: false, reason: 'refused in a test' };
    },
  };
  const options = { now: () => w.t, jitter: false, log: line => w.logs.push(String(line)) };
  // DATA_DIR is not one of the keys: it only keeps the demo from tripping over a database in the project folder
  if (demo) options.env = { DATA_DIR: TMP, ...env };
  else options.env = { APP_SECRET, STAFF_PIN, PUBLIC_BASE_URL: LIVE_BASE, MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't', ...env, DATA_DIR: env.DATA_DIR || fs.mkdtempSync(path.join(TMP, 'live-')) };
  if (fakeSms) options.sms = w.sms;

  w.app = createApp(options);
  w.server = http.createServer(w.app.handler);
  await new Promise(resolve => w.server.listen(0, '127.0.0.1', resolve));
  w.url = `http://127.0.0.1:${w.server.address().port}`;
  w.stop = async () => {
    if (w.stopped) return;
    w.stopped = true;
    await new Promise(resolve => { w.server.close(resolve); w.server.closeAllConnections(); });
    w.app.close();
  };
  w.skip = ms => { w.t += ms; };

  // jar: a Map of cookie name to value, sent with the request and updated from the answer.
  // A header set to undefined is left out, which is how a test drops x-hta or the content type.
  w.send = async (method, route, { body, jar, headers = {} } = {}) => {
    const h = method === 'GET' || method === 'HEAD' ? { ...headers } : { 'content-type': 'application/json', 'x-hta': '1', ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    if (jar && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const init = { method, headers: h, redirect: 'manual' };
    if (body instanceof ReadableStream) { init.body = body; init.duplex = 'half'; }
    else if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(w.url + route, init);
    const text = await res.text();
    // no test here expects the server to trip over itself; if it does, show what it logged
    assert.notEqual(res.status, 500, `${method} ${route} made the server fail: ${w.logs.at(-1)}`);
    const cookies = res.headers.getSetCookie();
    if (jar) for (const line of cookies) {
      const c = cookieParts(line);
      if (c.value === '' || c.attrs.includes('max-age=0')) jar.delete(c.name); else jar.set(c.name, c.value);
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* a page, not JSON */ }
    return { status: res.status, headers: res.headers, text, json, cookies };
  };
  w.get = (route, opts) => w.send('GET', route, opts);
  w.post = (route, body = {}, opts = {}) => w.send('POST', route, { ...opts, body });

  // fetch always writes the Host header itself, so a request that names another host is written by hand.
  // `body` is sent as it is; `host` is what the request claims to be addressed to.
  w.raw = (method, route, { host, headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: w.server.address().port, method, path: route, agent: false, setHost: host === undefined, headers: host === undefined ? headers : { host, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* a page, not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, cookies: res.headers['set-cookie'] || [] });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });

  // staff desk: sign in with the PIN and register a sale, which is what makes a number a customer
  w.staffJar = new Map();
  w.staffLogin = async (jar = w.staffJar) => {
    const r = await w.post('/api/staff/login', { pin: w.app.cfg.staffPin }, { jar });
    assert.equal(r.status, 200, 'staff sign-in failed: ' + r.text);
    return jar;
  };
  w.sale = async (p, fields = {}) => {
    await w.staffLogin();
    const r = await w.post('/api/staff/sales', { phone: p.phone, regNo: p.regNo, tyre: 'MRF ZVTV', size: '185/65 R15', qty: 4, odometerKm: 21400, ...fields }, { jar: w.staffJar });
    assert.equal(r.status, 200, 'registering a sale at the staff desk failed: ' + r.text);
    return { ...p, customerId: r.json.customerId, vehicleId: r.json.vehicleId, saleId: r.json.saleId, saleToken: r.json.passportUrl.split('#s=')[1], referralCode: r.json.customer.referral.code, sold: r.json };
  };
  w.customer = fields => w.sale(person(), fields);
  // the staff desk's search box. What is typed travels in the body of a POST, never in the address.
  w.lookup = async q => {
    await w.staffLogin();
    const r = await w.post('/api/staff/lookup', { q }, { jar: w.staffJar });
    assert.equal(r.status, 200, `looking up ${q} at the staff desk failed: ${r.text}`);
    return r.json.results;
  };

  // customer side
  w.ask = (p, extra = {}, opts) => w.post('/api/auth/request', { phone: p.phone, ...extra }, opts);
  w.verify = (p, code, extra = {}, opts) => w.post('/api/auth/verify', { phone: p.phone, code, ...extra }, opts);
  w.textsTo = p => w.texts.filter(x => x.phone === p.e164);
  w.codeFor = p => {
    const last = w.textsTo(p).at(-1);
    assert.ok(last, `no code was ever asked for ${p.phone}`);
    return last.code;
  };
  w.signIn = async (p, jar = new Map()) => {
    const asked = await w.ask(p);
    assert.equal(asked.status, 200, 'asking for a code failed: ' + asked.text);
    const done = await w.verify(p, w.codeFor(p), { plate: p.tail }, { jar });
    assert.equal(done.status, 200, 'signing in failed: ' + done.text);
    assert.ok(jar.get('hta_c'), 'signing in gave no session cookie');
    return jar;
  };
  w.me = jar => w.get('/api/me', { jar });
  w.count = (fromWhere, ...args) => w.app.db.q('SELECT COUNT(*) AS n FROM ' + fromWhere).get(...args).n;
  return w;
}

// status, body and every header except the date, for "these two answers cannot be told apart"
const shown = r => ({ status: r.status, body: r.text, headers: [...r.headers].filter(([k]) => k !== 'date').map(([k, v]) => `${k}: ${v}`).sort() });
const refused = (r, status, code, why) => {
  assert.equal(r.status, status, `${why || 'answer'}: ${r.text}`);
  assert.equal(r.json && r.json.error && r.json.error.code, code, `${why || 'answer'}: ${r.text}`);
};
// behind a proxy (TRUST_PROXY=1) the proxy adds the caller's address as the last entry of X-Forwarded-For
const from = address => ({ headers: { 'x-forwarded-for': address } });
// the database files in a live site's DATA_DIR that hold this text anywhere in them
const filesHolding = (dir, value) => fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile() && fs.readFileSync(path.join(dir, f)).includes(value));

/* ================================================================================================
   LIVE
   ================================================================================================ */

describe('a live site', () => {
  let w;
  before(async () => { w = await start(); });
  after(() => w && w.stop());
  // two hours pass before every test, so each one starts with a full allowance of codes, tries and requests
  beforeEach(() => w.skip(2 * HOUR));

  describe('what anyone can read', () => {
    test('the public settings carry no demo PIN, no sample customers and none of the secrets', async () => {
      const r = await w.get('/api/public/config');
      assert.equal(r.status, 200);
      assert.equal(r.json.mode, 'live');
      assert.equal(r.json.signIn, 'sms');
      assert.equal(Object.hasOwn(r.json, 'demo'), false);
      for (const hidden of [DEMO_PIN, STAFF_PIN, APP_SECRET, ...DEMO_SAMPLES.flatMap(s => [s.phone, s.plate])]) {
        assert.ok(!r.text.includes(hidden), `the public settings contain ${hidden}`);
      }
    });
  });

  describe('asking for a code', () => {
    test('a customer and an unknown number get exactly the same answer, and only the customer is texted', async () => {
      const known = await w.customer(), stranger = person();
      const a = await w.ask(known), b = await w.ask(stranger);
      assert.equal(a.status, 200);
      assert.deepEqual(a.json, { ok: true, wait: 60 });
      assert.deepEqual(shown(a), shown(b));
      assert.deepEqual(a.cookies, []);

      assert.equal(w.textsTo(known).length, 1);
      assert.equal(w.textsTo(stranger).length, 0);
      const { code } = w.textsTo(known)[0];
      assert.match(code, /^\d{6}$/);
      assert.ok(!a.text.includes(code), 'the code came back in the answer');

      // asking again too soon cannot be told apart either
      w.skip(20 * SEC);
      const a2 = await w.ask(known), b2 = await w.ask(stranger);
      assert.equal(a2.status, 429);
      assert.deepEqual(shown(a2), shown(b2));
      assert.equal(w.textsTo(known).length, 1);
    });

    test('the demo sample numbers are refused outright', async () => {
      const before = w.texts.length;
      for (const sample of DEMO_SAMPLES) {
        const r = await w.post('/api/auth/request', { phone: sample.phone });
        refused(r, 400, 'invalid', sample.phone);
        assert.equal(r.json.error.field, 'phone');
      }
      assert.equal(w.texts.length, before);
    });

    test('one code a minute for a phone: sooner is 429 with Retry-After, and a refusal costs nothing', async () => {
      const c = await w.customer();
      assert.equal((await w.ask(c)).status, 200);
      w.skip(45 * SEC);
      const early = await w.ask(c);
      refused(early, 429, 'slow-down');
      assert.equal(early.headers.get('retry-after'), '15');
      // writing the same number another way is still the same phone
      for (const spelling of [`+91 ${c.phone.slice(0, 5)} ${c.phone.slice(5)}`, '0' + c.phone, '91' + c.phone]) {
        refused(await w.post('/api/auth/request', { phone: spelling }), 429, 'slow-down', spelling);
      }
      assert.equal(w.textsTo(c).length, 1, 'a refused request sent a text');
      w.skip(15 * SEC);
      assert.equal((await w.ask(c)).status, 200);
      assert.equal(w.textsTo(c).length, 2);
    });

    // In the two tests below a number that is not a customer asks alongside the customer. The limits are the
    // same for every caller, so each of its answers must match the customer's to the last header.
    test('three codes in fifteen minutes for a phone, whoever it belongs to', async () => {
      const c = await w.customer(), stranger = person(), t0 = w.t;
      for (let i = 1; i <= 3; i++) {
        const a = await w.ask(c);
        assert.equal(a.status, 200, `code ${i}`);
        assert.deepEqual(shown(await w.ask(stranger)), shown(a), `request ${i} for a number that is not a customer`);
        w.skip(61 * SEC);
      }
      const fourth = await w.ask(c);
      refused(fourth, 429, 'slow-down');
      assert.equal(fourth.headers.get('retry-after'), String(15 * 60 - 3 * 61));
      assert.deepEqual(shown(await w.ask(stranger)), shown(fourth), 'the fourth request for a number that is not a customer');
      assert.equal(w.textsTo(c).length, 3);
      w.t = t0 + 15 * MIN;
      assert.equal((await w.ask(c)).status, 200);
      assert.equal(w.textsTo(c).length, 4);
      assert.equal(w.textsTo(stranger).length, 0);
    });

    test('six codes in a day for a phone, whoever it belongs to', async () => {
      const c = await w.customer(), stranger = person(), t0 = w.t;
      for (let i = 1; i <= 6; i++) {
        const a = await w.ask(c);
        assert.equal(a.status, 200, `code ${i}`);
        assert.deepEqual(shown(await w.ask(stranger)), shown(a), `request ${i} for a number that is not a customer`);
        w.skip(16 * MIN);   // far enough apart that only the daily limit can bite
      }
      const seventh = await w.ask(c);
      refused(seventh, 429, 'slow-down');
      assert.equal(seventh.headers.get('retry-after'), String(24 * 3600 - 6 * 16 * 60));
      assert.deepEqual(shown(await w.ask(stranger)), shown(seventh), 'the seventh request for a number that is not a customer');
      assert.equal(w.textsTo(c).length, 6);
      w.t = t0 + DAY;
      assert.equal((await w.ask(c)).status, 200);
      assert.equal(w.textsTo(stranger).length, 0);
    });

    test('ten code requests an hour from one address, and a made-up X-Forwarded-For header does not get round it', async () => {
      const c = await w.customer();
      for (let i = 1; i <= 10; i++) {
        const r = await w.ask(person(), {}, { headers: { 'x-forwarded-for': `203.0.113.${i}` } });
        assert.equal(r.status, 200, `request ${i}: ${r.text}`);
      }
      const next = await w.ask(c, {}, { headers: { 'x-forwarded-for': '203.0.113.99' } });
      refused(next, 429, 'slow-down');
      assert.equal(next.headers.get('retry-after'), '3600');
      assert.equal(w.textsTo(c).length, 0);
    });
  });

  describe('when the SMS provider says no', () => {
    test('the answer is an error that claims nothing was sent, the code is dead, and the phone is handed its allowance back', async () => {
      const c = await w.customer(), codesOnFile = w.count('otp_codes');
      w.sms.refuse = true;
      try {
        // four in a row in the same minute: more than a phone could ever ask for if any of them had counted.
        // Only the first reaches the provider; for the two minutes after a refusal the server answers for it.
        for (let i = 1; i <= 4; i++) {
          const r = await w.ask(c);
          refused(r, 502, 'sms-failed', `refusal ${i}`);
          assert.deepEqual(Object.keys(r.json), ['error']);
          assert.doesNotMatch(r.json.error.message, /\b(sent|on its way|delivered)\b/i);
        }
      } finally { w.sms.refuse = false; }
      assert.deepEqual(w.textsTo(c).map(x => x.ok), [false]);

      // a code the provider never carried opens nothing, and is not kept
      const jar = new Map();
      refused(await w.verify(c, w.codeFor(c), { plate: c.tail }, { jar }), 400, 'bad-code');
      assert.equal(jar.size, 0);
      assert.equal(w.count('otp_codes'), codesOnFile, 'the code that was never carried is still on file');

      // Two minutes on, the provider is asked again. The phone still has all three codes of its fifteen minutes,
      // which it would not if even one of the four refusals had counted, and it has no more than three.
      w.skip(2 * MIN);
      for (let i = 1; i <= 3; i++) {
        const ok = await w.ask(c);
        assert.equal(ok.status, 200, `code ${i} after the refusals: ${ok.text}`);
        w.skip(61 * SEC);
      }
      assert.deepEqual(w.textsTo(c).map(x => x.ok), [false, true, true, true]);
      refused(await w.ask(c), 429, 'slow-down', 'a fourth code in the fifteen minutes');
      assert.equal((await w.verify(c, w.codeFor(c), { plate: c.tail }, { jar })).status, 200);
      assert.equal((await w.me(jar)).json.signedIn, true);
    });

    test('for two minutes after a refusal every caller hears the same error, customer or not, and the provider is left alone', async () => {
      const c = await w.customer(), other = await w.customer(), host = await w.customer();
      const stranger = person(), friend = person();
      w.sms.refuse = true;
      let first;
      try { first = await w.ask(c); } finally { w.sms.refuse = false; }   // the provider is well again at once, but nobody knows that yet
      refused(first, 502, 'sms-failed');
      const askedOfProvider = w.texts.length;

      w.skip(2 * MIN - SEC);
      const during = {
        'another customer': await w.ask(other),
        'a number that is not a customer': await w.ask(stranger),
        'an invited friend': await w.ask(friend, { ref: host.referralCode }),
        'the same customer again': await w.ask(c),
      };
      for (const [who, r] of Object.entries(during)) assert.deepEqual(shown(r), shown(first), who);
      assert.equal(w.texts.length, askedOfProvider, 'the provider was asked again inside the two minutes');

      // two minutes to the second after the refusal, things are as they were
      w.skip(SEC);
      const again = await w.ask(other), unknown = await w.ask(stranger);
      assert.deepEqual([again.status, again.json], [200, { ok: true, wait: 60 }]);
      assert.deepEqual(shown(unknown), shown(again));
      assert.deepEqual(w.textsTo(other).map(x => x.ok), [true]);
      assert.equal(w.textsTo(stranger).length, 0);
      assert.equal((await w.verify(other, w.codeFor(other), { plate: other.tail })).status, 200);
    });

    test('a code that already arrived still works when a later request for a new one is refused by the provider', async () => {
      const c = await w.customer();
      assert.equal((await w.ask(c)).status, 200);
      const delivered = w.codeFor(c);
      w.skip(61 * SEC);
      w.sms.refuse = true;
      try { refused(await w.ask(c), 502, 'sms-failed'); } finally { w.sms.refuse = false; }
      assert.deepEqual(w.textsTo(c).map(x => x.ok), [true, false]);
      // nor does one more request, turned away while the provider is being left alone, take it away
      refused(await w.ask(c), 502, 'sms-failed', 'inside the two minutes');
      assert.equal(w.textsTo(c).length, 2);

      // the code the provider would not carry opens nothing; the one in the customer's hand still does
      const jar = new Map(), never = w.codeFor(c);
      if (never !== delivered) refused(await w.verify(c, never, { plate: c.tail }, { jar }), 400, 'bad-code', 'the code that was never carried');
      assert.equal(jar.size, 0);
      const r = await w.verify(c, delivered, { plate: c.tail }, { jar });
      assert.equal(r.status, 200, r.text);
      assert.equal((await w.me(jar)).json.signedIn, true);
    });

    test('an invited friend whose text the provider refused has not used up the invitation: once the provider is back, a code is texted',
      async () => {
        const host = await w.customer(), friend = person();
        w.sms.refuse = true;
        try {
          for (let i = 1; i <= 2; i++) {
            refused(await w.ask(friend, { ref: host.referralCode }), 502, 'sms-failed', `refusal ${i}`);
            w.skip(2 * MIN);   // past the two minutes in which the provider is left alone
          }
        } finally { w.sms.refuse = false; }
        assert.deepEqual(w.textsTo(friend).map(x => x.ok), [false, false]);

        const r = await w.ask(friend, { ref: host.referralCode });
        assert.deepEqual([r.status, r.json], [200, { ok: true, wait: 60 }]);
        assert.deepEqual(w.textsTo(friend).map(x => x.ok), [false, false, true], 'nothing has ever been texted to this number, and now nothing will be for a day');
        assert.equal((await w.verify(friend, w.codeFor(friend), { ref: host.referralCode })).status, 200);
      });
  });

  describe('checking the code', () => {
    test('five wrong codes kill the code; four do not', async () => {
      const unlucky = await w.customer(), careless = await w.customer();
      assert.equal((await w.ask(unlucky)).status, 200);
      assert.equal((await w.ask(careless)).status, 200);

      const jar = new Map(), code = w.codeFor(unlucky);
      for (let i = 1; i <= 5; i++) refused(await w.verify(unlucky, wrongCode(code), { plate: unlucky.tail }, { jar }), 400, 'bad-code', `wrong try ${i}`);
      refused(await w.verify(unlucky, code, { plate: unlucky.tail }, { jar }), 400, 'bad-code', 'the right code after five wrong ones');
      assert.equal(jar.size, 0);
      assert.equal((await w.me(jar)).json.signedIn, false);

      const code2 = w.codeFor(careless);
      for (let i = 1; i <= 4; i++) refused(await w.verify(careless, wrongCode(code2), { plate: careless.tail }), 400, 'bad-code', `wrong try ${i}`);
      assert.equal((await w.verify(careless, code2, { plate: careless.tail })).status, 200);
    });

    test('for a customer the right code alone is not enough: the vehicle number is asked for, and the code still works', async () => {
      const c = await w.customer(), jar = new Map();
      assert.equal((await w.ask(c)).status, 200);
      const code = w.codeFor(c);
      for (let i = 0; i < 2; i++) {
        const r = await w.verify(c, code, {}, { jar });
        refused(r, 400, 'need-plate');
        assert.deepEqual(r.cookies, []);
      }
      assert.equal((await w.me(jar)).json.signedIn, false);
      assert.equal((await w.verify(c, code, { plate: c.tail }, { jar })).status, 200);
      assert.equal((await w.me(jar)).json.hasPassport, true);
    });

    test('the code plus the last four characters of the plate signs in', async () => {
      // a temporary registration, whose last four characters are not all digits
      const c = await w.sale({ ...person(), regNo: 'T0926PB7A1B', tail: '7A1B' }), jar = new Map();
      assert.equal((await w.ask(c)).status, 200);
      // typed the way people type it: small letters and a space
      const r = await w.verify(c, w.codeFor(c), { plate: '7a 1b' }, { jar });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json, { ok: true, focusVehicleId: c.vehicleId, shortSession: false });
      const me = await w.me(jar);
      assert.equal(me.json.signedIn, true);
      assert.equal(me.json.hasPassport, true);
      assert.deepEqual(me.json.vehicles.map(v => v.regNo), [c.regNo]);
    });

    test('the code plus the QR code on the bill signs in with no plate, and opens the vehicle on that bill', async () => {
      const c = await w.customer();
      const second = person();
      const car2 = await w.sale({ ...c, regNo: second.regNo, tail: second.tail });   // a second vehicle on the same number
      assert.notEqual(car2.vehicleId, c.vehicleId);

      assert.equal((await w.ask(c)).status, 200);
      const jar = new Map();
      const r = await w.verify(c, w.codeFor(c), { sale: car2.saleToken }, { jar });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.focusVehicleId, car2.vehicleId);
      assert.deepEqual((await w.me(jar)).json.vehicles.map(v => v.regNo).sort(), [c.regNo, car2.regNo].sort());
    });

    test("somebody else's bill does not stand in for the plate", async () => {
      const c = await w.customer(), other = await w.customer(), jar = new Map();
      assert.equal((await w.ask(c)).status, 200);
      const code = w.codeFor(c);
      refused(await w.verify(c, code, { sale: other.saleToken }, { jar }), 400, 'need-plate');
      refused(await w.verify(c, code, { sale: other.saleToken, plate: other.tail }, { jar }), 400, 'bad-plate');
      assert.equal(jar.size, 0);
    });

    test('three wrong plates pause the number: after that even the right code and plate are turned away', async () => {
      const c = await w.customer(), jar = new Map();
      assert.equal((await w.ask(c)).status, 200);
      const code = w.codeFor(c);

      const first = await w.verify(c, code, { plate: WRONG_TAIL }, { jar });
      refused(first, 400, 'bad-plate');
      assert.equal(first.json.error.left, 2);
      const second = await w.verify(c, code, { plate: WRONG_TAIL }, { jar });
      refused(second, 400, 'bad-plate');
      assert.equal(second.json.error.left, 1);
      const third = await w.verify(c, code, { plate: WRONG_TAIL }, { jar });
      refused(third, 429, 'ask-counter', 'third wrong plate');
      // the answer is not a dead end: it says where to go and what will let the customer in
      assert.match(third.json.error.message, /counter/i);
      assert.match(third.json.error.message, /QR code/i);

      // the code is looked at before the pause, and the pause did not cancel it: so this is "paused", not "wrong code"
      refused(await w.verify(c, code, { plate: c.tail }, { jar }), 429, 'ask-counter', 'right plate straight after');
      refused(await w.verify(c, code, {}, { jar }), 429, 'ask-counter', 'no plate at all');
      // a fresh code does not help
      w.skip(61 * SEC);
      assert.equal((await w.ask(c)).status, 200);
      refused(await w.verify(c, w.codeFor(c), { plate: c.tail }, { jar }), 429, 'ask-counter', 'fresh code, right plate');
      assert.equal(jar.size, 0);
      assert.equal((await w.me(jar)).json.signedIn, false);

      // the pause lifts by itself a day later
      w.skip(DAY);
      assert.equal((await w.ask(c)).status, 200);
      assert.equal((await w.verify(c, w.codeFor(c), { plate: c.tail }, { jar })).status, 200);
    });

    test('two wrong plates and then the right one signs in, and the slate is clean afterwards', async () => {
      const c = await w.customer();
      assert.equal((await w.ask(c)).status, 200);
      const code = w.codeFor(c);
      refused(await w.verify(c, code, { plate: WRONG_TAIL }), 400, 'bad-plate');
      refused(await w.verify(c, code, { plate: WRONG_TAIL }), 400, 'bad-plate');
      assert.equal((await w.verify(c, code, { plate: c.tail })).status, 200);

      // next time one slip is one slip, not the third
      w.skip(61 * SEC);
      assert.equal((await w.ask(c)).status, 200);
      const slip = await w.verify(c, w.codeFor(c), { plate: WRONG_TAIL });
      refused(slip, 400, 'bad-plate');
      assert.equal(slip.json.error.left, 2);
    });

    test('a paused number can be let in at the counter with the QR code from its bill, and that ends the pause', async () => {
      const c = await w.customer(), other = await w.customer(), jar = new Map();
      assert.equal((await w.ask(c)).status, 200);
      const code = w.codeFor(c);
      for (let i = 0; i < 2; i++) refused(await w.verify(c, code, { plate: WRONG_TAIL }), 400, 'bad-plate');
      refused(await w.verify(c, code, { plate: WRONG_TAIL }), 429, 'ask-counter');

      // the QR code is no key by itself: it needs the code texted to the phone, and it must be this customer's bill
      refused(await w.verify(c, wrongCode(code), { sale: c.saleToken }, { jar }), 400, 'bad-code', 'the QR code with a wrong code');
      refused(await w.verify(c, code, { sale: other.saleToken }, { jar }), 429, 'ask-counter', "somebody else's QR code");
      refused(await w.verify(c, code, { sale: other.saleToken, plate: c.tail }, { jar }), 429, 'ask-counter', "somebody else's QR code and the right plate");
      assert.equal(jar.size, 0);

      // staff show the QR code for the sale, and the code already in the customer's hand still works with it
      const r = await w.verify(c, code, { sale: c.saleToken }, { jar });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json, { ok: true, focusVehicleId: c.vehicleId, shortSession: false });
      assert.equal((await w.me(jar)).json.hasPassport, true);

      // the pause is over, not just stepped round: the plate works next time, and one slip is the first of three again
      w.skip(61 * SEC);
      assert.equal((await w.ask(c)).status, 200);
      const slip = await w.verify(c, w.codeFor(c), { plate: WRONG_TAIL });
      refused(slip, 400, 'bad-plate');
      assert.equal(slip.json.error.left, 2);
      assert.equal((await w.verify(c, w.codeFor(c), { plate: c.tail })).status, 200);
    });

    test('a fresh code and the QR code from the bill also let a paused number in', async () => {
      const c = await w.customer();
      assert.equal((await w.ask(c)).status, 200);
      const code = w.codeFor(c);
      for (let i = 0; i < 2; i++) refused(await w.verify(c, code, { plate: WRONG_TAIL }), 400, 'bad-plate');
      refused(await w.verify(c, code, { plate: WRONG_TAIL }), 429, 'ask-counter');
      w.skip(61 * SEC);
      assert.equal((await w.ask(c)).status, 200);
      refused(await w.verify(c, w.codeFor(c), { plate: c.tail }), 429, 'ask-counter', 'fresh code, right plate');
      const r = await w.verify(c, w.codeFor(c), { sale: c.saleToken });
      assert.equal(r.status, 200, r.text);
    });

    test('whether a number is paused is told only to somebody holding its code: a wrong code gets the usual answer', async () => {
      const c = await w.customer(), stranger = person();
      assert.equal((await w.ask(c)).status, 200);
      const code = w.codeFor(c);
      for (let i = 0; i < 2; i++) refused(await w.verify(c, code, { plate: WRONG_TAIL }), 400, 'bad-plate');
      refused(await w.verify(c, code, { plate: WRONG_TAIL }), 429, 'ask-counter');

      const guess = await w.verify(c, wrongCode(code), { plate: c.tail });
      refused(guess, 400, 'bad-code');
      assert.deepEqual(shown(guess), shown(await w.verify(stranger, wrongCode(code), { plate: c.tail })), 'a paused number and a number that is not a customer');
      // the guess cost one try at the code and nothing else
      refused(await w.verify(c, code, { plate: c.tail }), 429, 'ask-counter');
    });

    test('a code works once', async () => {
      const c = await w.customer(), jar = new Map();
      assert.equal((await w.ask(c)).status, 200);
      const code = w.codeFor(c);
      assert.equal((await w.verify(c, code, { plate: c.tail })).status, 200);
      refused(await w.verify(c, code, { plate: c.tail }, { jar }), 400, 'bad-code', 'second use');
      assert.equal(jar.size, 0);
    });

    test('asking for a new code cancels the one before', async () => {
      const c = await w.customer();
      assert.equal((await w.ask(c)).status, 200);
      const first = w.codeFor(c);
      w.skip(61 * SEC);
      assert.equal((await w.ask(c)).status, 200);
      const second = w.codeFor(c);
      // the server draws codes at random; in the one-in-a-million case that both are equal there is nothing to tell apart
      if (first !== second) refused(await w.verify(c, first, { plate: c.tail }), 400, 'bad-code', 'the earlier code');
      assert.equal((await w.verify(c, second, { plate: c.tail })).status, 200);
    });

    test('a code is good for five minutes and no longer', async () => {
      const prompt = await w.customer(), slow = await w.customer(), jar = new Map();
      assert.equal((await w.ask(prompt)).status, 200);
      assert.equal((await w.ask(slow)).status, 200);
      w.skip(5 * MIN - SEC);
      assert.equal((await w.verify(prompt, w.codeFor(prompt), { plate: prompt.tail })).status, 200);
      w.skip(2 * SEC);
      refused(await w.verify(slow, w.codeFor(slow), { plate: slow.tail }, { jar }), 400, 'bad-code', 'five minutes and a second later');
      assert.equal(jar.size, 0);
    });
  });

  describe('sessions', () => {
    test('the session cookie is HttpOnly and SameSite=Strict, lasts thirty days, and its value appears nowhere else', async () => {
      const c = await w.customer();
      assert.equal((await w.ask(c)).status, 200);
      const r = await w.verify(c, w.codeFor(c), { plate: c.tail });
      assert.equal(r.status, 200);
      assert.equal(r.cookies.length, 1);
      const cookie = cookieParts(r.cookies[0]);
      assert.equal(cookie.name, 'hta_c');
      assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
      for (const attr of ['httponly', 'samesite=strict', 'path=/', `max-age=${30 * 24 * 3600}`]) assert.ok(cookie.attrs.includes(attr), `${attr} is missing from: ${r.cookies[0]}`);
      assert.ok(!r.text.includes(cookie.value));
    });

    test('a sign-in lasts thirty days and then ends', async () => {
      const c = await w.customer(), jar = await w.signIn(c);
      w.skip(30 * DAY - MIN);
      assert.equal((await w.me(jar)).json.signedIn, true);
      w.skip(2 * MIN);
      assert.deepEqual((await w.me(jar)).json, { signedIn: false });
    });

    test('on a tablet that has been used for the staff desk, a customer sign-in lasts fifteen minutes', async () => {
      const c = await w.customer();
      const tablet = await w.staffLogin(new Map());
      assert.equal((await w.ask(c)).status, 200);
      const r = await w.verify(c, w.codeFor(c), { plate: c.tail }, { jar: tablet });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.shortSession, true);
      assert.ok(cookieParts(r.cookies.find(line => line.startsWith('hta_c='))).attrs.includes('max-age=900'), r.cookies.join(' | '));
      w.skip(14 * MIN);
      assert.equal((await w.me(tablet)).json.signedIn, true);
      w.skip(2 * MIN);
      assert.equal((await w.me(tablet)).json.signedIn, false);
    });

    test('without a session, or with a made-up one, /api/me says signed out and nothing more', async () => {
      assert.deepEqual((await w.get('/api/me')).json, { signedIn: false });
      const forged = new Map([['hta_c', 'A'.repeat(43)]]);
      assert.deepEqual((await w.me(forged)).json, { signedIn: false });
      refused(await w.post('/api/me/reminders', { on: true }, { jar: forged }), 401, 'signed-out');
      refused(await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar: forged }), 401, 'signed-out');

      // a staff session does not pass for a customer's, nor a customer's for staff
      const c = await w.customer(), mine = await w.signIn(c);
      await w.staffLogin();
      assert.deepEqual((await w.me(new Map([['hta_c', w.staffJar.get('hta_s')]]))).json, { signedIn: false });
      refused(await w.get('/api/staff/status', { jar: new Map([['hta_s', mine.get('hta_c')]]) }), 401, 'staff-signed-out');
    });

    test("/api/me shows a customer their own passport and nothing of anybody else's, even a friend they invited", async () => {
      const a = await w.customer();
      const b = await w.customer({ referralCode: a.referralCode });   // b bought on a's invitation, so the two records are linked
      const jarA = await w.signIn(a), jarB = await w.signIn(b);
      const meA = await w.me(jarA), meB = await w.me(jarB);

      assert.deepEqual(meA.json.vehicles.map(v => v.regNo), [a.regNo]);
      assert.equal(meA.json.phoneLast4, a.phone.slice(-4));
      assert.equal(meA.json.referral.joined, 1);
      assert.deepEqual(meB.json.vehicles.map(v => v.regNo), [b.regNo]);
      assert.equal(meB.json.phoneLast4, b.phone.slice(-4));
      for (const [who, me, other] of [['a', meA, b], ['b', meB, a]]) {
        for (const theirs of [other.phone, other.regNo, other.saleToken, other.referralCode]) assert.ok(!me.text.includes(theirs), `${who} was shown ${theirs}`);
      }
      // not even the customer's own full number goes back out
      assert.ok(!meA.text.includes(a.phone));

      // who you are comes from the cookie alone: naming somebody else in the address changes nothing
      const sly = await w.get(`/api/me?phone=${b.phone}&customerId=${b.customerId}&id=${b.customerId}`, { jar: jarA });
      assert.deepEqual(sly.json, meA.json);
    });

    test('signing out ends that session on the server, and leaves the other device signed in', async () => {
      const c = await w.customer();
      const phone = await w.signIn(c);
      w.skip(61 * SEC);
      const laptop = await w.signIn(c);
      const copied = new Map(phone);   // the cookie as somebody who copied it would still hold it

      const out = await w.post('/api/auth/signout', {}, { jar: phone });
      assert.equal(out.status, 200);
      const cleared = cookieParts(out.cookies.find(line => line.startsWith('hta_c=')));
      assert.equal(cleared.value, '');
      assert.ok(cleared.attrs.includes('max-age=0'));
      assert.equal(phone.has('hta_c'), false);
      assert.deepEqual((await w.me(copied)).json, { signedIn: false });
      assert.equal((await w.me(laptop)).json.signedIn, true);
    });

    test('signing out everywhere ends every session of that customer and nobody else\'s', async () => {
      const c = await w.customer(), neighbour = await w.customer();
      const phone = await w.signIn(c);
      w.skip(61 * SEC);
      const laptop = await w.signIn(c);
      const theirs = await w.signIn(neighbour);

      const out = await w.post('/api/auth/signout', { everywhere: true }, { jar: new Map(phone) });
      assert.equal(out.status, 200);
      assert.deepEqual((await w.me(phone)).json, { signedIn: false });
      assert.deepEqual((await w.me(laptop)).json, { signedIn: false });
      assert.equal(w.count('sessions WHERE phone = ?', c.e164), 0);
      assert.equal((await w.me(theirs)).json.signedIn, true);
    });

    test("when staff remove a sale typed in by mistake and it was the number's only one, that number is signed out and is a stranger again", async () => {
      const c = await w.customer(), keeper = await w.customer();
      const second = person();
      const car2 = await w.sale({ ...keeper, regNo: second.regNo, tail: second.tail });   // a second sale, on a second vehicle
      const jar = await w.signIn(c), keeperJar = await w.signIn(keeper);

      const gone = await w.post(`/api/staff/sales/${c.saleId}/void`, {}, { jar: w.staffJar });
      assert.deepEqual([gone.status, gone.json], [200, { ok: true, customer: null }]);
      assert.deepEqual((await w.me(jar)).json, { signedIn: false });
      assert.equal(w.count('sessions WHERE phone = ?', c.e164), 0);
      assert.equal(w.count('customers WHERE phone = ?', c.e164), 0);
      w.skip(61 * SEC);
      const texts = w.textsTo(c).length;
      assert.equal((await w.ask(c)).status, 200);
      assert.equal(w.textsTo(c).length, texts, 'a number with no sale left was texted a code');

      // a customer with another sale left keeps the passport and stays signed in
      await w.staffLogin();
      const one = await w.post(`/api/staff/sales/${car2.saleId}/void`, {}, { jar: w.staffJar });
      assert.equal(one.status, 200, one.text);
      const me = await w.me(keeperJar);
      assert.equal(me.json.signedIn, true);
      assert.deepEqual(me.json.vehicles.map(v => v.regNo), [keeper.regNo]);
    });
  });

  describe('requests that did not come from the site\'s own page', () => {
    const outsiders = {
      'no x-hta header': { 'x-hta': undefined },
      'x-hta with the wrong value': { 'x-hta': 'true' },
      'a form content type': { 'content-type': 'application/x-www-form-urlencoded' },
      'a text/plain content type': { 'content-type': 'text/plain' },
      'no content type of its own': { 'content-type': undefined },
      'the Origin of another site': { origin: 'https://evil.example' },
      'a look-alike Origin': { origin: LIVE_BASE + '.evil.example' },
      'an opaque Origin': { origin: 'null' },
      'Sec-Fetch-Site: cross-site': { 'sec-fetch-site': 'cross-site' },
      'Sec-Fetch-Site: same-site': { 'sec-fetch-site': 'same-site' },
    };

    test('a POST without x-hta, with a content type that is not JSON, or from a foreign origin is refused with 403 and does nothing', async () => {
      const c = await w.customer(), jar = await w.signIn(c);
      const texts = w.textsTo(c).length;
      for (const [what, headers] of Object.entries(outsiders)) {
        refused(await w.ask(c, {}, { headers }), 403, 'forbidden', `asking for a code with ${what}`);
        refused(await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar: new Map(jar), headers }), 403, 'forbidden', `deleting with ${what}`);
        refused(await w.post('/api/auth/signout', { everywhere: true }, { jar: new Map(jar), headers }), 403, 'forbidden', `signing out with ${what}`);
      }
      assert.equal(w.textsTo(c).length, texts, 'a refused request sent a text');
      const me = await w.me(jar);
      assert.equal(me.json.hasPassport, true);
      assert.deepEqual(me.json.vehicles.map(v => v.regNo), [c.regNo]);
    });

    test('the same POST from the site\'s own origin is let through', async () => {
      const c = await w.customer();
      const r = await w.ask(c, {}, { headers: { origin: LIVE_BASE, 'sec-fetch-site': 'same-origin' } });
      assert.equal(r.status, 200, r.text);
      assert.equal(w.textsTo(c).length, 1);
    });

    test('fields the server does not expect are refused, so nobody can name another customer in a request', async () => {
      const c = await w.customer(), other = await w.customer();
      const extra = await w.ask(c, { admin: true });
      refused(extra, 400, 'invalid');
      assert.equal(extra.json.error.field, 'admin');
      assert.equal(w.textsTo(c).length, 0);

      const jar = await w.signIn(c), otherJar = await w.signIn(other);
      const code = w.codeFor(c);
      for (const [route, body, field] of [
        ['/api/auth/verify', { phone: c.phone, code, plate: c.tail, customerId: other.customerId }, 'customerId'],
        ['/api/me/delete', { confirm: 'DELETE', phone: other.phone }, 'phone'],
        ['/api/me/reminders', { on: true, customerId: other.customerId }, 'customerId'],
        ['/api/auth/signout', { everywhere: true, phone: other.phone }, 'phone'],
      ]) {
        const r = await w.post(route, body, { jar: new Map(jar) });
        refused(r, 400, 'invalid', route);
        assert.equal(r.json.error.field, field, route);
      }
      // nothing happened to either of them
      for (const [who, j] of [[c, jar], [other, otherJar]]) {
        const me = await w.me(j);
        assert.equal(me.json.hasPassport, true);
        assert.deepEqual(me.json.vehicles.map(v => v.regNo), [who.regNo]);
        assert.equal(me.json.reminders.state, 'no');
      }
    });

    test('a body that is not one JSON object is refused', async () => {
      const c = await w.customer();
      refused(await w.send('POST', '/api/auth/request', { body: `{"phone":"${c.phone}"` }), 400, 'bad-json', 'cut-off JSON');
      for (const body of [`["${c.phone}"]`, `"${c.phone}"`, '42', 'null']) refused(await w.send('POST', '/api/auth/request', { body }), 400, 'invalid', body);
      assert.equal(w.textsTo(c).length, 0);
    });

    test('a body over 16 KB is refused, whether or not it says how long it is', async () => {
      const c = await w.customer();
      // a request that is fine in every way except its size: JSON may carry any amount of white space
      const padded = bytes => { const head = `{"phone":"${c.phone}"`; return head + ' '.repeat(bytes - head.length - 1) + '}'; };

      refused(await w.send('POST', '/api/auth/request', { body: padded(17 * 1024) }), 413, 'too-large', 'with Content-Length');
      const bytes = new TextEncoder().encode(padded(17 * 1024));
      const inPieces = new ReadableStream({
        start(ctrl) {
          for (let i = 0; i < bytes.length; i += 4096) ctrl.enqueue(bytes.subarray(i, i + 4096));
          ctrl.close();
        },
      });
      refused(await w.send('POST', '/api/auth/request', { body: inPieces }), 413, 'too-large', 'sent in pieces with no Content-Length');
      assert.equal(w.textsTo(c).length, 0);

      // the very same request at 15 KB is read and acted on
      const ok = await w.send('POST', '/api/auth/request', { body: padded(15 * 1024) });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(w.textsTo(c).length, 1);
    });
  });

  describe('deleting my data', () => {
    test('it needs the word DELETE, exactly', async () => {
      const c = await w.customer(), jar = await w.signIn(c);
      for (const body of [{}, { confirm: '' }, { confirm: 'delete' }, { confirm: 'YES' }, { confirm: true }]) {
        const r = await w.post('/api/me/delete', body, { jar: new Map(jar) });
        refused(r, 400, 'invalid', JSON.stringify(body));
        assert.equal(r.json.error.field, 'confirm');
      }
      assert.equal((await w.me(jar)).json.hasPassport, true);
      assert.equal(w.count('customers WHERE phone = ?', c.e164), 1);
    });

    test('it needs a sign-in less than ten minutes old; signing in again opens the ten minutes again', async () => {
      const c = await w.customer(), jar = await w.signIn(c);
      assert.equal((await w.me(jar)).json.freshSignIn, true);
      w.skip(10 * MIN + SEC);
      assert.equal((await w.me(jar)).json.freshSignIn, false);
      refused(await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar: new Map(jar) }), 403, 'reauth');
      assert.equal((await w.me(jar)).json.hasPassport, true);
      assert.equal(w.count('customers WHERE phone = ?', c.e164), 1);

      const fresh = await w.signIn(c);
      w.skip(9 * MIN);
      assert.equal((await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar: fresh })).status, 200);
      assert.equal(w.count('customers WHERE phone = ?', c.e164), 0);
    });

    test('afterwards the customer, vehicles, sales, visits, breakdowns and every session are gone, and nobody else is touched', async () => {
      const c = await w.customer(), bystander = await w.customer();
      const second = person();
      await w.sale({ ...c, regNo: second.regNo });   // two vehicles, two sales
      const phone = await w.signIn(c);
      // a breakdown shared from the road, which also starts this customer's ten-minute and daily counters
      assert.equal((await w.post('/api/me/breakdown', { lat: 30.9, lng: 75.85 }, { jar: phone })).status, 200);
      w.skip(61 * SEC);
      const laptop = await w.signIn(c);
      const theirs = await w.signIn(bystander);
      const copied = new Map(phone);

      const left = () => ({
        customers: w.count('customers WHERE phone = ?', c.e164),
        vehicles: w.count('vehicles WHERE customer_id = ?', c.customerId),
        sales: w.count('sales WHERE customer_id = ?', c.customerId),
        visits: w.count('visits WHERE customer_id = ?', c.customerId),
        breakdowns: w.count('breakdowns WHERE customer_id = ?', c.customerId),
        // the breakdown counters are kept under the customer's row id, so they belong to nobody once the row is gone
        counters: w.count('throttle WHERE key IN (?, ?)', `bd:gap:${c.customerId}`, `bd:day:${c.customerId}`),
        sessions: w.count('sessions WHERE phone = ?', c.e164),
      });
      assert.deepEqual(left(), { customers: 1, vehicles: 2, sales: 2, visits: 2, breakdowns: 1, counters: 2, sessions: 2 });
      // every row of every table, as text, to look for the phone and the plates wherever they might be kept
      const everything = () => w.app.db.q("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map(t => t.name + ' ' + JSON.stringify(w.app.db.q(`SELECT * FROM "${t.name}"`).all())).join('\n');
      const personal = [c.phone, c.regNo, second.regNo];
      for (const value of personal) assert.ok(everything().includes(value), `${value} should be on file before the delete`);
      // and the staff desk finds this customer by the number and by either plate
      for (const q of personal) assert.deepEqual((await w.lookup(q)).map(found => found.customerId), [c.customerId], `staff should find ${q} before the delete`);

      const done = await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar: laptop });
      assert.equal(done.status, 200, done.text);
      assert.deepEqual(done.json, { ok: true });
      assert.equal(laptop.has('hta_c'), false, 'the cookie was not cleared');
      assert.deepEqual(left(), { customers: 0, vehicles: 0, sales: 0, visits: 0, breakdowns: 0, counters: 0, sessions: 0 });
      for (const value of personal) assert.ok(!everything().includes(value), `${value} is still in the database after the delete`);

      // the other device is signed out too, and the staff desk can no longer find the number or either plate
      assert.deepEqual((await w.me(copied)).json, { signedIn: false });
      for (const q of personal) assert.deepEqual(await w.lookup(q), [], `staff can still find ${q}`);
      // the number is a stranger again: asking for a code texts nobody
      w.skip(61 * SEC);
      const texts = w.textsTo(c).length;
      assert.equal((await w.ask(c)).status, 200);
      assert.equal(w.textsTo(c).length, texts);

      const me = await w.me(theirs);
      assert.equal(me.json.hasPassport, true);
      assert.deepEqual(me.json.vehicles.map(v => v.regNo), [bystander.regNo]);
    });

    test('a number that deletes its data and then buys again gets a new record: no row id is handed out twice, and nothing kept under the old one comes back', async () => {
      const c = await w.customer(), jar = await w.signIn(c);
      assert.equal((await w.post('/api/me/reminders', { on: true }, { jar })).status, 200);
      const tapped = await w.post('/api/me/breakdown', {}, { jar });
      assert.deepEqual([tapped.status, tapped.json.repeat], [200, false]);
      assert.equal((await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar })).status, 200);

      // The very next sale at the counter is for the same number, with nobody registered in between: the deleted
      // rows were the newest of their kind, which is exactly when a database that reuses ids would reuse them.
      const plate = person();
      const again = await w.sale({ ...c, regNo: plate.regNo, tail: plate.tail });
      assert.deepEqual({ customer: again.customerId > c.customerId, vehicle: again.vehicleId > c.vehicleId, sale: again.saleId > c.saleId }, { customer: true, vehicle: true, sale: true },
        `row ids before the delete ${[c.customerId, c.vehicleId, c.saleId]}, after it ${[again.customerId, again.vehicleId, again.saleId]}`);
      assert.notEqual(again.saleToken, c.saleToken);

      w.skip(61 * SEC);
      const fresh = await w.signIn(again);
      const me = await w.me(fresh);
      assert.deepEqual(me.json.vehicles.map(v => v.regNo), [plate.regNo]);
      assert.equal(me.json.card.stamps, 1);
      assert.equal(me.json.reminders.state, 'no', 'the yes to reminders belonged to the deleted record');
      // a minute after the old record's breakdown, the new one's is taken: the ten-minute wait was not inherited
      const first = await w.post('/api/me/breakdown', {}, { jar: fresh });
      assert.deepEqual([first.status, first.json.repeat], [200, false]);
      assert.equal(w.count('breakdowns WHERE customer_id = ?', again.customerId), 1);
    });
  });

  describe('the breakdown button', () => {
    const tap = (jar, body = {}) => w.post('/api/me/breakdown', body, { jar });
    // what the staff desk has on file for one customer, newest first
    const onFile = async c => {
      await w.staffLogin();
      const r = await w.get('/api/staff/breakdowns', { jar: w.staffJar });
      assert.equal(r.status, 200, r.text);
      return r.json.items.filter(i => i.customerId === c.customerId);
    };
    // the shop a customer with no location is told to call, and two spots on the road a little way from it
    const firstShop = () => { const { id, name, phone } = w.app.cfg.settings.shops[0]; return { id, name, phone }; };
    const spot = step => { const s = w.app.cfg.settings.shops[0], r = v => Math.round(v * 1e5) / 1e5; return { lat: r(s.lat + step), lng: r(s.lng + step) }; };

    test('a location that arrives within ten minutes of a tap that had none is added to that breakdown, and staff see it as new again', async () => {
      const c = await w.customer(), jar = await w.signIn(c), t0 = w.t;
      const shop = firstShop(), here = spot(0.01), elsewhere = spot(0.02);

      // the first tap goes out before the phone has found itself
      const first = await tap(jar, { vehicleId: c.vehicleId });
      assert.deepEqual([first.status, first.json], [200, { ok: true, shared: false, repeat: false, shop, km: null }]);
      let rows = await onFile(c);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.deepEqual({ at: row.at, lat: row.lat, lng: row.lng, vehicleId: row.vehicleId, regNo: row.regNo, seenAt: row.seenAt },
        { at: t0, lat: null, lng: null, vehicleId: c.vehicleId, regNo: c.regNo, seenAt: null });
      // somebody at the counter has seen it
      assert.equal((await w.post(`/api/staff/breakdowns/${row.id}/seen`, {}, { jar: w.staffJar })).status, 200);

      // a second tap that still has no location adds nothing
      w.skip(3 * MIN);
      const blind = await tap(jar);
      assert.deepEqual([blind.status, blind.json], [200, { ok: true, shared: false, repeat: true, shop }]);
      assert.deepEqual((await onFile(c)).map(r => [r.id, r.lat, r.seenAt]), [[row.id, null, t0]]);

      // then the phone finds itself, a second short of ten minutes after the first tap
      w.t = t0 + 10 * MIN - SEC;
      const located = await tap(jar, { ...here, accuracyM: 18 });
      assert.equal(located.status, 200, located.text);
      assert.ok(located.json.km > 0 && located.json.km < 5, `kilometres to the shop, got ${located.json.km}`);
      assert.deepEqual(located.json, { ok: true, shared: true, repeat: false, shop, km: located.json.km });
      rows = await onFile(c);
      assert.equal(rows.length, 1, 'the late location was stored as a second breakdown');
      assert.deepEqual({ id: rows[0].id, at: rows[0].at, lat: rows[0].lat, lng: rows[0].lng, accuracyM: rows[0].accuracyM, vehicleId: rows[0].vehicleId, seenAt: rows[0].seenAt },
        { id: row.id, at: t0, ...here, accuracyM: 18, vehicleId: c.vehicleId, seenAt: null });

      // one more tap, with a location or without: the breakdown on file stands as it is
      for (const body of [elsewhere, {}]) {
        const again = await tap(jar, body);
        assert.deepEqual([again.status, again.json], [200, { ok: true, shared: false, repeat: true, shop }], JSON.stringify(body));
      }
      assert.deepEqual((await onFile(c)).map(r => [r.id, r.lat, r.lng]), [[row.id, here.lat, here.lng]]);
      assert.equal(w.count('breakdowns WHERE customer_id = ?', c.customerId), 1);
    });

    test('a second tap inside ten minutes changes nothing when the first already had a location; after the ten minutes it is a new breakdown', async () => {
      const c = await w.customer(), jar = await w.signIn(c), t0 = w.t;
      const here = spot(0.01), elsewhere = spot(0.02);

      const first = await tap(jar, here);
      assert.deepEqual([first.status, first.json.shared, first.json.repeat], [200, true, false]);
      w.skip(5 * MIN);
      const again = await tap(jar, elsewhere);
      assert.deepEqual([again.status, again.json.shared, again.json.repeat], [200, false, true]);
      assert.equal(Object.hasOwn(again.json, 'km'), false);
      assert.deepEqual((await onFile(c)).map(r => [r.lat, r.lng]), [[here.lat, here.lng]]);

      w.t = t0 + 10 * MIN;
      const later = await tap(jar, elsewhere);
      assert.deepEqual([later.status, later.json.shared, later.json.repeat], [200, true, false]);
      assert.deepEqual((await onFile(c)).map(r => [r.at, r.lat, r.lng]), [[t0 + 10 * MIN, elsewhere.lat, elsewhere.lng], [t0, here.lat, here.lng]]);
    });
  });

  describe('reminders', () => {
    const stopToken = (c) => w.app.db.q('SELECT stop_token AS t FROM customers WHERE phone = ?').get(c.e164).t;
    const state = async jar => (await w.me(jar)).json.reminders.state;
    const pressStop = token => w.send('POST', '/stop', { body: 't=' + token, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-hta': undefined } });

    test('they are off until the customer says yes, and the customer can switch them on and off', async () => {
      const c = await w.customer(), jar = await w.signIn(c);
      assert.equal(await state(jar), 'no');

      const on = await w.post('/api/me/reminders', { on: true }, { jar });
      assert.deepEqual([on.status, on.json], [200, { ok: true, reminders: 'yes' }]);
      const me = await w.me(jar);
      assert.equal(me.json.reminders.state, 'yes');
      assert.equal(me.json.reminders.by, 'customer');

      const off = await w.post('/api/me/reminders', { on: false }, { jar });
      assert.deepEqual([off.status, off.json], [200, { ok: true, reminders: 'stopped' }]);
      assert.equal(await state(jar), 'stopped');

      assert.equal((await w.post('/api/me/reminders', { on: true }, { jar })).json.reminders, 'yes');
      assert.equal(await state(jar), 'yes');

      refused(await w.post('/api/me/reminders', { on: 'yes' }, { jar }), 400, 'invalid', 'a word instead of true or false');
      refused(await w.post('/api/me/reminders', { on: false }), 401, 'signed-out', 'no session');
      assert.equal(await state(jar), 'yes');
    });

    test('opening the stop link changes nothing; pressing its button stops reminders, with no script and no sign-in', async () => {
      const c = await w.customer(), jar = await w.signIn(c);
      assert.equal((await w.post('/api/me/reminders', { on: true }, { jar })).status, 200);
      const token = stopToken(c);

      // a link preview, or the customer looking: twice, and by HEAD
      for (const method of ['GET', 'GET', 'HEAD']) assert.equal((await w.send(method, '/stop/' + token)).status, 200, method);
      const page = await w.get('/stop/' + token);
      assert.match(page.headers.get('content-type'), /^text\/html/);
      assert.match(page.text, /<form[^>]*method="post"[^>]*action="\/stop"/);
      assert.ok(page.text.includes(`name="t" value="${token}"`));
      assert.doesNotMatch(page.text, /demo/i, 'a live page carries demo wording');
      assert.ok(!page.text.includes(c.phone) && !page.text.includes(c.regNo));
      assert.equal(await state(jar), 'yes');

      const pressed = await pressStop(token);
      assert.equal(pressed.status, 200);
      assert.match(pressed.headers.get('content-type'), /^text\/html/);
      assert.doesNotMatch(pressed.text, /demo/i);
      assert.equal(await state(jar), 'stopped');

      // only the customer, signed in, can switch them back on
      assert.equal((await w.post('/api/me/reminders', { on: true }, { jar })).json.reminders, 'yes');
      assert.equal(await state(jar), 'yes');
    });

    test('a stop link that is not real gets the same page as a real one, and stops nobody', async () => {
      const c = await w.customer(), jar = await w.signIn(c);
      assert.equal((await w.post('/api/me/reminders', { on: true }, { jar })).status, 200);
      const token = stopToken(c);
      const fake = token.split('').reverse().join('');
      assert.notEqual(fake, token);

      const bogus = await pressStop(fake);
      assert.equal(await state(jar), 'yes');
      const real = await pressStop(token);
      assert.equal(await state(jar), 'stopped');
      assert.equal(bogus.status, real.status);
      assert.equal(bogus.text, real.text);
    });
  });

  describe('a friend invited by a customer', () => {
    test('gets a code, signs in with no vehicle number, and sees an invitation but no passport and nothing about the customer', async () => {
      const host = await w.customer(), friend = person(), jar = new Map();

      const asked = await w.ask(friend, { ref: host.referralCode });
      assert.deepEqual([asked.status, asked.json], [200, { ok: true, wait: 60 }]);
      assert.equal(w.textsTo(friend).length, 1);

      const done = await w.verify(friend, w.codeFor(friend), { ref: host.referralCode }, { jar });
      assert.equal(done.status, 200, done.text);
      assert.deepEqual(done.json, { ok: true, focusVehicleId: null, shortSession: false });

      const me = await w.me(jar);
      const service = (await w.get('/api/public/config')).json.referral.service;
      assert.deepEqual(me.json, { signedIn: true, hasPassport: false, phoneLast4: friend.phone.slice(-4), invited: true, referralService: service });
      for (const theirs of [host.phone, host.regNo, host.referralCode]) assert.ok(!me.text.includes(theirs));
    });

    test('when the friend then buys, both find a free service on their passports', async () => {
      const host = await w.customer(), friend = person(), jar = new Map();
      assert.equal((await w.ask(friend, { ref: host.referralCode })).status, 200);
      assert.equal((await w.verify(friend, w.codeFor(friend), { ref: host.referralCode }, { jar })).status, 200);

      await w.sale(friend);   // staff register the friend's first purchase; nobody types the code in again
      const mine = await w.me(jar);
      assert.equal(mine.json.hasPassport, true);
      assert.deepEqual(mine.json.card.available.map(g => g.source), ['referral']);
      assert.deepEqual(mine.json.card.used, []);

      const hostMe = await w.me(await w.signIn(host));
      assert.deepEqual(hostMe.json.card.available.map(g => g.source), ['referral']);
      assert.equal(hostMe.json.referral.joined, 1);
      assert.ok(!hostMe.text.includes(friend.phone) && !hostMe.text.includes(friend.regNo));
    });

    test('an unknown number with no invitation, or with a code nobody has, gets the usual answer and no text', async () => {
      const stranger = person(), other = person();
      const made = await w.ask(stranger, { ref: NOBODYS_REFERRAL_CODE });
      const none = await w.ask(other);
      assert.deepEqual([made.status, made.json], [200, { ok: true, wait: 60 }]);
      assert.deepEqual(shown(made), shown(none));
      assert.equal(w.textsTo(stranger).length + w.textsTo(other).length, 0);
    });

    test('an invitation gets a number texted twice a day at most; after that it gets the answer an unknown number gets, and no text', async () => {
      const host = await w.customer(), friend = person(), t0 = w.t;
      for (let i = 1; i <= 2; i++) {
        assert.equal((await w.ask(friend, { ref: host.referralCode })).status, 200, `code ${i}`);
        assert.equal(w.textsTo(friend).length, i);
        w.skip(16 * MIN);
      }
      // the third is not refused, which would tell the caller this number is no customer: it is quietly not texted
      const third = await w.ask(friend, { ref: host.referralCode }), unknown = await w.ask(person());
      assert.deepEqual([third.status, third.json], [200, { ok: true, wait: 60 }]);
      assert.deepEqual(shown(third), shown(unknown));
      assert.equal(w.textsTo(friend).length, 2);

      // still nothing two minutes short of a day after the first; a day after it the invitation is good for a text again
      w.t = t0 + DAY - 2 * MIN;
      assert.equal((await w.ask(friend, { ref: host.referralCode })).status, 200);
      assert.equal(w.textsTo(friend).length, 2);
      w.t = t0 + DAY;
      assert.equal((await w.ask(friend, { ref: host.referralCode })).status, 200);
      assert.equal(w.textsTo(friend).length, 3);
      assert.equal((await w.verify(friend, w.codeFor(friend), { ref: host.referralCode })).status, 200);
    });

    test("with an invitation code in hand, a customer's number and a stranger's number still get the same answers", async () => {
      const host = await w.customer(), target = await w.customer(), stranger = person();
      // three in a row: the third is where the stranger's two-a-day invitation runs out
      for (let i = 1; i <= 3; i++) {
        const a = await w.ask(target, { ref: host.referralCode }), b = await w.ask(stranger, { ref: host.referralCode });
        assert.equal(a.status, 200, `request ${i}: ${a.text}`);
        assert.deepEqual(shown(b), shown(a), `request ${i}`);
        w.skip(61 * SEC);
      }
      // and the fourth in fifteen minutes is refused alike
      const a4 = await w.ask(target, { ref: host.referralCode }), b4 = await w.ask(stranger, { ref: host.referralCode });
      refused(a4, 429, 'slow-down');
      assert.deepEqual(shown(b4), shown(a4));
      // behind the same answers: the customer was texted each time, the stranger only while the invitation lasted
      assert.equal(w.textsTo(target).length, 3);
      assert.equal(w.textsTo(stranger).length, 2);
    });

    test('a friend who never bought can delete too: the invitation and the session go', async () => {
      const host = await w.customer(), friend = person(), jar = new Map();
      assert.equal((await w.ask(friend, { ref: host.referralCode })).status, 200);
      assert.equal((await w.verify(friend, w.codeFor(friend), { ref: host.referralCode }, { jar })).status, 200);
      assert.equal(w.count('referrals WHERE friend_phone = ?', friend.e164), 1);
      const copied = new Map(jar);

      const done = await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar });
      assert.equal(done.status, 200, done.text);
      assert.equal(w.count('referrals WHERE friend_phone = ?', friend.e164), 0);
      assert.equal(w.count('sessions WHERE phone = ?', friend.e164), 0);
      assert.deepEqual((await w.me(copied)).json, { signedIn: false });
    });
  });
});

/* ================================================================================================
   LIVE, behind one proxy: limits are per address
   ================================================================================================ */

describe('a live site behind one proxy (TRUST_PROXY=1, SMS_HOURLY_CAP=3)', () => {
  let w;
  before(async () => { w = await start({ env: { TRUST_PROXY: '1', SMS_HOURLY_CAP: '3' } }); });
  after(() => w && w.stop());
  beforeEach(() => w.skip(2 * HOUR));

  test('the cap on code requests is per address: ten an hour, and the next address is not held up', async () => {
    const c = await w.customer();
    for (let i = 1; i <= 10; i++) assert.equal((await w.ask(person(), {}, from('198.51.100.7'))).status, 200, `request ${i}`);
    const eleventh = await w.ask(c, {}, from('198.51.100.7'));
    refused(eleventh, 429, 'slow-down');
    assert.equal(eleventh.headers.get('retry-after'), '3600');
    assert.equal(w.textsTo(c).length, 0);

    assert.equal((await w.ask(c, {}, from('198.51.100.8'))).status, 200);
    assert.equal(w.textsTo(c).length, 1);

    w.skip(HOUR);
    assert.equal((await w.ask(person(), {}, from('198.51.100.7'))).status, 200);
  });

  test('what a caller writes in front of the proxy\'s own entry is ignored', async () => {
    for (let i = 1; i <= 10; i++) assert.equal((await w.ask(person(), {}, from(`10.0.0.${i}, 198.51.100.20`))).status, 200, `request ${i}`);
    refused(await w.ask(person(), {}, from('10.9.9.9, 198.51.100.20')), 429, 'slow-down');
  });

  test('every address in one IPv6 /64 counts as the same caller', async () => {
    for (let i = 1; i <= 10; i++) assert.equal((await w.ask(person(), {}, from(`2401:4900:1c2a:77:${i.toString(16)}::1`))).status, 200, `request ${i}`);
    refused(await w.ask(person(), {}, from('2401:4900:1c2a:77:ffff:ffff:ffff:ffff')), 429, 'slow-down');
    assert.equal((await w.ask(person(), {}, from('2401:4900:1c2a:78::1'))).status, 200);
  });

  test('the hourly spending guard: no more texts than SMS_HOURLY_CAP, whoever asks and from wherever; once it is full every caller hears the same error', async () => {
    const customers = [await w.customer(), await w.customer(), await w.customer(), await w.customer()];
    // only a text that is really asked for counts: numbers nobody would text can ask without using the guard up
    for (let i = 0; i < 5; i++) assert.equal((await w.ask(person(), {}, from(`198.51.100.${70 + i}`))).status, 200, `a number that is not a customer, ${i + 1}`);
    for (let i = 0; i < 3; i++) assert.equal((await w.ask(customers[i], {}, from(`198.51.100.${50 + i}`))).status, 200, `customer ${i + 1}`);
    assert.deepEqual(customers.map(c => w.textsTo(c).length), [1, 1, 1, 0]);

    // full. It is not "slow down", which would be this caller's own doing, and it is the same for a number that is not a customer
    const texts = w.texts.length;
    const fourth = await w.ask(customers[3], {}, from('198.51.100.60'));
    refused(fourth, 502, 'sms-failed');
    assert.deepEqual(Object.keys(fourth.json), ['error']);
    assert.deepEqual(shown(await w.ask(person(), {}, from('198.51.100.61'))), shown(fourth), 'a number that is not a customer');
    // being turned away costs the phone nothing: asked again at once, the answer is the same and not "one a minute"
    refused(await w.ask(customers[3], {}, from('198.51.100.60')), 502, 'sms-failed', 'asked again at once');

    w.skip(HOUR - SEC);
    refused(await w.ask(customers[3], {}, from('198.51.100.60')), 502, 'sms-failed', 'a second short of the hour');
    assert.equal(w.texts.length, texts, 'the provider was asked while the guard was full');
    w.skip(SEC);
    assert.equal((await w.ask(customers[3], {}, from('198.51.100.60'))).status, 200);
    assert.equal(w.textsTo(customers[3]).length, 1);
  });

  test('a text the provider refused is handed back to the phone and to the spending guard, but the address that asked has still used one of its ten', async () => {
    const c = await w.customer(), next = await w.customer();
    w.sms.refuse = true;
    try { refused(await w.ask(c, {}, from('198.51.100.90')), 502, 'sms-failed'); } finally { w.sms.refuse = false; }
    w.skip(2 * MIN);   // past the two minutes in which the provider is left alone

    // the address: nine more requests are all it has left this hour, so a failing provider cannot be hammered for nothing
    for (let i = 2; i <= 10; i++) assert.equal((await w.ask(person(), {}, from('198.51.100.90'))).status, 200, `request ${i} from the address`);
    const eleventh = await w.ask(person(), {}, from('198.51.100.90'));
    refused(eleventh, 429, 'slow-down');
    assert.equal(eleventh.headers.get('retry-after'), String(3600 - 2 * 60));

    // the phone and the guard: three codes in these fifteen minutes and three texts this hour are all of either,
    // and all three are still there
    for (let i = 1; i <= 3; i++) {
      const r = await w.ask(c, {}, from(`198.51.100.${90 + i}`));
      assert.equal(r.status, 200, `code ${i} after the refusal: ${r.text}`);
      w.skip(61 * SEC);
    }
    assert.deepEqual(w.textsTo(c).map(x => x.ok), [false, true, true, true]);
    // and no more than was owed came back
    refused(await w.ask(c, {}, from('198.51.100.94')), 429, 'slow-down', 'a fourth code for the phone');
    refused(await w.ask(next, {}, from('198.51.100.95')), 502, 'sms-failed', 'a fourth text this hour');
    assert.equal(w.textsTo(next).length, 0);
  });

  test('thirty tries at a code an hour from one address', async () => {
    const nobody = person();
    for (let i = 1; i <= 30; i++) refused(await w.verify(nobody, '123456', {}, from('198.51.100.30')), 400, 'bad-code', `try ${i}`);
    const next = await w.verify(nobody, '123456', {}, from('198.51.100.30'));
    refused(next, 429, 'slow-down');
    assert.equal(next.headers.get('retry-after'), '3600');
    refused(await w.verify(nobody, '123456', {}, from('198.51.100.31')), 400, 'bad-code', 'another address');
  });

  test('a hundred and twenty requests a minute from one address, of any kind', async () => {
    for (let i = 1; i <= 120; i++) assert.equal((await w.get('/api/public/config', from('198.51.100.40'))).status, 200, `request ${i}`);
    const next = await w.get('/api/public/config', from('198.51.100.40'));
    refused(next, 429, 'slow-down');
    assert.equal(next.headers.get('retry-after'), '60');
    assert.equal((await w.get('/api/public/config', from('198.51.100.41'))).status, 200);
    w.skip(MIN);
    assert.equal((await w.get('/api/public/config', from('198.51.100.40'))).status, 200);
  });
});

describe('a live site behind one proxy, with many friends invited in one hour (TRUST_PROXY=1)', () => {
  test('invited numbers are texted twenty times an hour between them; the next gets the answer an unknown number gets, and customers are still texted', async t => {
    const w = await start({ env: { TRUST_PROXY: '1' } });
    t.after(() => w.stop());
    const host = await w.customer(), c = await w.customer(), t0 = w.t;
    const friends = Array.from({ length: 21 }, person), late = friends[20];
    const invite = { ref: host.referralCode };

    for (let i = 0; i < 20; i++) {
      const r = await w.ask(friends[i], invite, from(`198.51.100.${100 + i}`));
      assert.equal(r.status, 200, `friend ${i + 1}: ${r.text}`);
    }
    const passedOver = await w.ask(late, invite, from('198.51.100.130')), unknown = await w.ask(person(), {}, from('198.51.100.131'));
    assert.deepEqual([passedOver.status, passedOver.json], [200, { ok: true, wait: 60 }]);
    assert.deepEqual(shown(passedOver), shown(unknown));
    assert.deepEqual(friends.map(f => w.textsTo(f).length), [...Array(20).fill(1), 0]);

    // the customers' texts do not come out of the friends' budget
    assert.equal((await w.ask(c, {}, from('198.51.100.132'))).status, 200);
    assert.equal(w.textsTo(c).length, 1);

    // an hour after the first of the twenty there is room again, and the friend who was passed over has lost
    // neither of the two texts an invitation is good for in a day
    w.t = t0 + HOUR - SEC;
    assert.equal((await w.ask(friends[19], invite, from('198.51.100.119'))).status, 200);
    assert.equal(w.textsTo(friends[19]).length, 1, 'a second short of the hour');
    w.t = t0 + HOUR;
    for (let i = 1; i <= 2; i++) {
      assert.equal((await w.ask(late, invite, from('198.51.100.130'))).status, 200);
      assert.equal(w.textsTo(late).length, i, `text ${i} for the friend who was passed over`);
      w.skip(16 * MIN);
    }
  });
});

/* ================================================================================================
   LIVE, restarted; what LIVE leaves on disk; LIVE with no MSG91 keys; LIVE on https
   ================================================================================================ */

describe('a live site that is restarted', () => {
  test('customers stay signed in, and nobody is handed a fresh allowance of codes', async t => {
    const first = await start();
    t.after(() => first.stop());
    const c = await first.customer();
    const jar = await first.signIn(c);   // one code asked for, just now
    await first.stop();

    const second = await start({ env: { DATA_DIR: first.app.cfg.dataDir }, at: first.t + 10 * SEC });
    t.after(() => second.stop());
    const me = await second.me(jar);
    assert.equal(me.json.hasPassport, true);
    assert.deepEqual(me.json.vehicles.map(v => v.regNo), [c.regNo]);

    const again = await second.ask(c);
    refused(again, 429, 'slow-down');
    assert.equal(again.headers.get('retry-after'), '50');
    assert.equal(second.textsTo(c).length, 0);
  });
});

/* These look at the files in DATA_DIR while the server is still running. Deleting a row cleans the database
   file itself, but the row can stay readable in the write-ahead log beside it until that log is emptied. */
describe('what a live site leaves in its database files', () => {
  test('once a customer has deleted their data, their phone and vehicle number are not left in the database files on disk', async t => {
    const w = await start();
    t.after(() => w.stop());
    const c = await w.customer(), bystander = await w.customer(), jar = await w.signIn(c);
    const dir = w.app.cfg.dataDir;
    assert.notDeepEqual(filesHolding(dir, c.phone), [], 'the phone should be on disk before the delete');
    assert.notDeepEqual(filesHolding(dir, c.regNo), [], 'the vehicle number should be on disk before the delete');

    assert.equal((await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar })).status, 200);
    assert.equal(w.count('customers WHERE phone = ?', c.e164), 0);
    assert.deepEqual({ phone: filesHolding(dir, c.phone), plate: filesHolding(dir, c.regNo) }, { phone: [], plate: [] });
    // the files were emptied of this customer, not of everybody
    assert.notDeepEqual(filesHolding(dir, bystander.phone), [], "another customer's record should still be on disk");
  });

  test("once staff have removed a sale typed in with the wrong number, that number and its vehicle number are not left in the database files on disk", async t => {
    const w = await start();
    t.after(() => w.stop());
    const c = await w.customer();
    const dir = w.app.cfg.dataDir;
    assert.notDeepEqual(filesHolding(dir, c.phone), [], 'the phone should be on disk before the sale is removed');

    const gone = await w.post(`/api/staff/sales/${c.saleId}/void`, {}, { jar: w.staffJar });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(w.count('customers WHERE phone = ?', c.e164), 0);
    assert.deepEqual({ phone: filesHolding(dir, c.phone), plate: filesHolding(dir, c.regNo) }, { phone: [], plate: [] });
  });

  test('once an invited friend who never bought has deleted their data, their phone number is not left in the database files on disk',
    async t => {
      const w = await start();
      t.after(() => w.stop());
      const host = await w.customer(), friend = person(), jar = new Map();
      assert.equal((await w.ask(friend, { ref: host.referralCode })).status, 200);
      assert.equal((await w.verify(friend, w.codeFor(friend), { ref: host.referralCode }, { jar })).status, 200);
      const dir = w.app.cfg.dataDir;
      assert.notDeepEqual(filesHolding(dir, friend.phone), [], 'the phone should be on disk before the delete');

      assert.equal((await w.post('/api/me/delete', { confirm: 'DELETE' }, { jar })).status, 200);
      assert.equal(w.count('referrals WHERE friend_phone = ?', friend.e164), 0);
      assert.equal(w.count('sessions WHERE phone = ?', friend.e164), 0);
      assert.deepEqual(filesHolding(dir, friend.phone), []);
    });

  test('housekeeping empties the write-ahead log too: an invitation that has lapsed leaves no phone number on disk, nor in the copy taken that day', async t => {
    const w = await start();
    t.after(() => w.stop());
    const host = await w.customer(), friend = person();
    assert.equal((await w.ask(friend, { ref: host.referralCode })).status, 200);
    assert.equal((await w.verify(friend, w.codeFor(friend), { ref: host.referralCode })).status, 200);
    const dir = w.app.cfg.dataDir;
    assert.equal(w.count('referrals WHERE friend_phone = ?', friend.e164) + w.count('sessions WHERE phone = ?', friend.e164), 2);
    assert.notDeepEqual(filesHolding(dir, friend.phone), [], 'the phone should be on disk while the invitation stands');

    // the sign-in ended after thirty days, and an invitation nobody took up is dropped after a year
    w.skip(366 * DAY);
    w.app.housekeeping();
    assert.equal(w.count('referrals WHERE friend_phone = ?', friend.e164) + w.count('sessions WHERE phone = ?', friend.e164), 0);
    assert.deepEqual(filesHolding(dir, friend.phone), []);
    const copies = path.join(dir, 'backups');
    assert.equal(fs.readdirSync(copies).length, 1, 'housekeeping should have taken the daily copy');
    assert.deepEqual(filesHolding(copies, friend.phone), []);
    // the customer who invited them was not swept out with the invitation
    assert.notDeepEqual(filesHolding(dir, host.phone), [], 'the customer who sent the invitation should still be on disk');
    assert.deepEqual(w.logs.filter(line => /backup failed/.test(line)), []);
  });
});

describe('a live site with no MSG91 keys', () => {
  let w;
  before(async () => { w = await start({ env: { MSG91_AUTH_KEY: undefined, MSG91_TEMPLATE_ID: undefined }, fakeSms: false }); });
  after(() => w && w.stop());

  test('customer sign-in is refused with 503 for everyone, the settings say it is off, and the staff desk still works', async () => {
    assert.equal(w.app.cfg.mode, 'live');
    assert.equal((await w.get('/api/public/config')).json.signIn, 'off');
    const c = await w.customer();   // staff signed in and registered a sale
    const known = await w.ask(c), unknown = await w.ask(person());
    refused(known, 503, 'sign-in-off');
    assert.deepEqual(shown(known), shown(unknown));
    assert.doesNotMatch(known.json.error.message, /\bsent\b/i);
    assert.equal(w.count('otp_codes'), 0, 'a code was made although it could not be sent');
  });
});

describe('a live site on https', () => {
  const BASE = 'https://passport.example.test';
  let w;
  before(async () => { w = await start({ env: { PUBLIC_BASE_URL: BASE } }); });
  after(() => w && w.stop());

  test('the session cookie is also Secure, and links are built on the configured address, not on the Host header', async () => {
    const c = await w.customer();
    assert.equal((await w.ask(c)).status, 200);
    const jar = new Map();
    const r = await w.verify(c, w.codeFor(c), { plate: c.tail }, { jar, headers: { origin: BASE } });
    assert.equal(r.status, 200, r.text);
    const cookie = cookieParts(r.cookies[0]);
    for (const attr of ['secure', 'httponly', 'samesite=strict']) assert.ok(cookie.attrs.includes(attr), `${attr} is missing from: ${r.cookies[0]}`);

    // this request arrives with "Host: 127.0.0.1:<port>", which is not the configured address
    const me = await w.me(jar);
    assert.equal(me.json.referral.link, `${BASE}/passport/?ref=${c.referralCode}`);
    assert.ok(c.sold.passportUrl.startsWith(BASE + '/passport/#s='));
  });

  test('the same host over plain http counts as a foreign origin', async () => {
    const c = await w.customer();
    refused(await w.ask(c, {}, { headers: { origin: BASE.replace('https:', 'http:') } }), 403, 'forbidden');
    assert.equal(w.textsTo(c).length, 0);
  });

  test('a live site answers under its own name and any other: only a demo nobody asked for is kept to this computer', async () => {
    for (const host of [new URL(BASE).host, 'www.example.test', '203.0.113.9:8080']) {
      const r = await w.raw('GET', '/api/public/config', { host });
      assert.equal(r.status, 200, `${host}: ${r.text}`);
      assert.equal(r.json.mode, 'live');
    }
  });
});

/* ================================================================================================
   DEMO: no keys set
   ================================================================================================ */

describe('the demo (no keys set)', () => {
  let w;
  before(async () => { w = await start({ demo: true }); });
  after(() => w && w.stop());
  beforeEach(() => w.skip(2 * HOUR));

  test('the public settings say demo and carry the demo PIN and the sample customers', async () => {
    assert.equal(w.app.cfg.mode, 'demo');
    const r = await w.get('/api/public/config');
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'demo');
    assert.equal(r.json.signIn, 'demo');
    assert.equal(r.json.demo.staffPin, DEMO_PIN);
    assert.ok(r.json.demo.samples.length >= 1);
    for (const s of r.json.demo.samples) assert.match(s.phone, /^555\d{7}$/, 'a sample number that could be a real mobile');
  });

  test('a sample customer is shown the code on the page, signs in with it and the sample plate, and no SMS is asked for', async () => {
    const { samples } = (await w.get('/api/public/config')).json.demo;
    const sample = samples[0], jar = new Map();

    const asked = await w.post('/api/auth/request', { phone: sample.phone });
    assert.equal(asked.status, 200, asked.text);
    assert.equal(asked.json.ok, true);
    assert.match(asked.json.demo.code, /^\d{6}$/);

    refused(await w.post('/api/auth/verify', { phone: sample.phone, code: asked.json.demo.code }, { jar }), 400, 'need-plate');
    const done = await w.post('/api/auth/verify', { phone: sample.phone, code: asked.json.demo.code, plate: sample.plate.slice(-4) }, { jar });
    assert.equal(done.status, 200, done.text);
    const me = await w.me(jar);
    assert.equal(me.json.hasPassport, true);
    assert.deepEqual(me.json.vehicles.map(v => v.regNo), [sample.plate]);
    assert.deepEqual(w.texts, [], 'the demo asked the SMS provider for something');
  });

  test('a 555 number that is not a sample gets no code, and a real mobile number cannot be typed in at all', async () => {
    const stranger = await w.post('/api/auth/request', { phone: '5550000199' });
    assert.deepEqual([stranger.status, stranger.json], [200, { ok: true, wait: 60, demo: { code: null } }]);

    const real = await w.post('/api/auth/request', { phone: '9876500001' });
    refused(real, 400, 'invalid');
    assert.equal(real.json.error.field, 'phone');
    assert.deepEqual(w.texts, []);
  });

  test('a POST from a foreign origin is refused here too, and one from the address the demo is open at is not', async () => {
    const sample = DEMO_SAMPLES[1];
    refused(await w.post('/api/auth/request', { phone: sample.phone }, { headers: { origin: 'https://evil.example' } }), 403, 'forbidden');
    const own = await w.post('/api/auth/request', { phone: sample.phone }, { headers: { origin: w.url } });
    assert.equal(own.status, 200, own.text);
  });

  /* This demo was not asked for by name: it is what a server with no keys falls back to. If such a server is
     reached under any name but this computer's own (through a tunnel, or a proxy on the same machine), it must
     not hand the sample customers and the demo PIN to whoever is on the other end. */
  const JSON_POST = { 'content-type': 'application/json', 'x-hta': '1' };

  test("reached under any name but this computer's own, it answers 503: no settings, no sign-in, no staff desk, no stop link", async () => {
    const sample = DEMO_SAMPLES[2];
    const consent = () => w.app.db.q('SELECT reminders_ok AS yes, stop_token AS token FROM customers WHERE phone = ?').get('+91' + sample.phone);
    const { token } = consent();
    assert.equal(consent().yes, 1, 'this sample customer should start with reminders on');
    const calls = [
      ['GET', '/api/public/config'],
      ['GET', '/api/me'],
      ['POST', '/api/auth/request', { headers: JSON_POST, body: JSON.stringify({ phone: sample.phone }) }],
      ['POST', '/api/staff/login', { headers: JSON_POST, body: JSON.stringify({ pin: DEMO_PIN }) }],
      ['GET', '/api/staff/status'],
      ['GET', '/stop/' + token],
      ['POST', '/stop', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 't=' + token }],
    ];
    const secrets = [DEMO_PIN, ...DEMO_SAMPLES.flatMap(s => [s.phone, s.plate])];
    // a tunnel's name, a name with a port, the machine's address on the local network, look-alikes, and IPv6 that is not loopback
    for (const host of ['passport.example.com', 'demo.example.com:8443', '192.168.1.20:3000', 'localhost.example.com', '127.0.0.1.example.com', 'notlocalhost', '[2001:db8::1]:3000']) {
      for (const [method, route, opts] of calls) {
        const r = await w.raw(method, route, { host, ...opts });
        refused(r, 503, 'not-set-up', `${method} ${route} as ${host}`);
        assert.deepEqual(r.cookies, [], `${method} ${route} as ${host} set a cookie`);
        for (const secret of secrets) assert.ok(!r.text.includes(secret), `${method} ${route} as ${host} gave away ${secret}`);
      }
      // the pages themselves still open; it is what they would fetch that is closed
      const page = await w.raw('GET', '/passport/', { host });
      assert.equal(page.status, 200, `/passport/ as ${host}`);
      assert.match(page.headers['content-type'], /^text\/html/);
    }
    // and nothing was done: the stop button pressed from outside stopped nobody
    assert.equal(consent().yes, 1);
    assert.deepEqual(w.texts, []);
  });

  test("under this computer's own names, with or without a port, the same requests are answered", async () => {
    const { port } = w.server.address();
    for (const host of ['localhost', 'localhost:8080', '127.0.0.1', `127.0.0.1:${port}`, '[::1]', '[::1]:3000']) {
      const r = await w.raw('GET', '/api/public/config', { host });
      assert.equal(r.status, 200, `${host}: ${r.text}`);
      assert.equal(r.json.mode, 'demo');
      assert.equal(r.json.demo.staffPin, DEMO_PIN);
    }
    const asked = await w.raw('POST', '/api/auth/request', { host: 'localhost:8080', headers: JSON_POST, body: JSON.stringify({ phone: DEMO_SAMPLES[2].phone }) });
    assert.equal(asked.status, 200, asked.text);
    assert.match(asked.json.demo.code, /^\d{6}$/);
    const page = await w.raw('GET', '/stop/' + 'a'.repeat(24), { host: '[::1]:3000' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
  });
});

/* ================================================================================================
   DEMO: asked for by name
   ================================================================================================ */

describe('a demo that was asked for (PASSPORT_MODE=demo)', () => {
  test('it answers under whatever name it is opened at', async t => {
    const w = await start({ demo: true, env: { PASSPORT_MODE: 'demo' } });
    t.after(() => w.stop());
    assert.equal(w.app.cfg.mode, 'demo');
    const hosts = ['demo.example.com', '192.168.1.20:3000'];
    for (const [i, host] of hosts.entries()) {
      const r = await w.raw('GET', '/api/public/config', { host });
      assert.equal(r.status, 200, `${host}: ${r.text}`);
      assert.equal(r.json.mode, 'demo');
      assert.equal(r.json.demo.staffPin, DEMO_PIN);

      const sample = DEMO_SAMPLES[i];
      const asked = await w.raw('POST', '/api/auth/request', { host, headers: { 'content-type': 'application/json', 'x-hta': '1' }, body: JSON.stringify({ phone: sample.phone }) });
      assert.equal(asked.status, 200, `${host}: ${asked.text}`);
      assert.match(asked.json.demo.code, /^\d{6}$/);
    }
  });
});
