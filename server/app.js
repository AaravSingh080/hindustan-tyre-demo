'use strict';

/* The HTTP layer: the site's own files, and the /api routes behind the tyre passport and the staff page.
   Identity comes only from a session cookie this server issued. Nothing a browser sends is trusted to say
   who it is, what something cost, or what was earned. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { loadConfig } = require('./config');
const { openDb, getMeta, setMeta, tx, audit, sweep, backup, DAY_MS } = require('./db');
const { Invalid, is, need, opt, shape, tidy } = require('./validate');
const throttle = require('./throttle');
const est = require('./estimate');
const store = require('./store');
const { dueItems, markReminder } = require('./reminders');
const { makeSms } = require('./sms');
const { qrSvg } = require('./qr');
const { seedDemo, DEMO_SAMPLES, DEMO_STAFF } = require('./seed');
const pages = require('./pages');
const { makeChat } = require('./chat');
const { makeStaff } = require('./staff');
const stock = require('./stock');
const stats = require('./stats');
const { makeOffsite, offsiteSettings } = require('./offsite');
const { importRows, BATCH: IMPORT_BATCH } = require('./importer');
const { overview } = require('./overview');
const { readTyres } = require('./tyres');

const MIN = 60e3, HOUR = 3600e3;

const LIMITS = {
  api: { limit: 120, windowMs: MIN },              // any visitor, per address
  staffApi: { limit: 400, windowMs: MIN },         // a signed-in staff device, per session
  otpIp: { limit: 10, windowMs: HOUR },            // code requests from one address
  otpGap: { limit: 1, windowMs: MIN },             // one code a minute per phone
  otpPhone: { limit: 3, windowMs: 15 * MIN },
  otpPhoneDay: { limit: 6, windowMs: 24 * HOUR },
  otpInvite: { limit: 2, windowMs: 24 * HOUR },    // a number that is not a customer yet (an invited friend)
  otpInviteAll: { limit: 20, windowMs: HOUR },     // all such numbers together, so strangers cannot use up the customers' budget
  verifyIp: { limit: 30, windowMs: HOUR },
  stopIp: { limit: 20, windowMs: HOUR },
  breakdownGap: { limit: 1, windowMs: 10 * MIN },
  breakdownDay: { limit: 5, windowMs: 24 * HOUR },
  chatIp: { limit: 20, windowMs: 10 * MIN },       // chat messages from one address
  chatIpDay: { limit: 150, windowMs: 24 * HOUR },
  chatAll: { limit: 600, windowMs: HOUR },         // all visitors together: a ceiling on what the AI model can be asked
  stat: { limit: 60, windowMs: MIN },              // counts a page may send, per address
};
const CHAT_TURNS = 12, CHAT_USER_MAX = 600, CHAT_REPLY_MAX = 1200;
const OTP_TTL = 5 * MIN, OTP_TRIES = 5;
const CUSTOMER_TTL = 30 * DAY_MS, CUSTOMER_TTL_SHOP_DEVICE = 15 * MIN, REAUTH_WINDOW = 10 * MIN;
const STAFF_TTL = 12 * HOUR, STAFF_IDLE = 30 * MIN, DEVICE_TTL = 90 * DAY_MS;
// wrong PINs: a browser that has signed in before has its own counters (fifteen minutes and a day) and cannot be
// locked out by strangers; everyone else shares a counter per address and one for the whole site, each doubling up to four hours
const PIN_LOCK_DEVICE = { tries: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 15 * MIN };
const PIN_LOCK_IP = { tries: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 4 * HOUR };
const PIN_LOCK_ALL = { tries: 20, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 4 * HOUR };
// and a slow guesser who stays under those is stopped by a count for the whole day
const PIN_LOCK_DAY = { tries: 60, windowMs: 24 * HOUR, lockMs: 12 * HOUR, maxLockMs: 24 * HOUR };
const PLATE_LOCK = { tries: 3, windowMs: 24 * HOUR, lockMs: 24 * HOUR, maxLockMs: 7 * 24 * HOUR };
const BODY_CAP = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.csv': 'text/csv; charset=utf-8',
};
// the only things this server hands out as files. Server code, settings, data and tools are not on the list.
const PAGES = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/passport/', 'passport/index.html'], ['/staff/', 'staff/index.html'], ['/privacy/', 'privacy/index.html'], ['/tyres/', 'tyres/index.html'], ['/admin/', 'admin/index.html'], ['/staff/job/', 'staff/job/index.html'], ['/compare/', 'compare/index.html']]);
const APP_PAGES = new Set(['passport/index.html', 'staff/index.html', 'privacy/index.html', 'tyres/index.html', 'admin/index.html', 'staff/job/index.html', 'compare/index.html']);
const ASSET_DIRS = new Set(['css', 'js', 'assets']);
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || null; }
}

const sha = v => crypto.createHash('sha256').update(v).digest('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const minutes = ms => { const m = Math.ceil(ms / MIN); return m >= 120 ? `${Math.ceil(m / 60)} hours` : m === 1 ? '1 minute' : `${m} minutes`; };

// IPv4 as it is; IPv6 cut to its /64, because one phone or home line owns a whole /64 of addresses
function normaliseIp(raw) {
  let ip = String(raw || '').trim().toLowerCase();
  // some proxies write the port too: 198.51.100.7:51234 or [2001:db8::1]:51234
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  ip = ip.split('%')[0];
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return 'unknown';
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

function createApp(options = {}) {
  const cfg = options.config || loadConfig(options.env || process.env, options);
  const clock = options.now || Date.now;
  const log = options.log || (() => {});
  const demo = cfg.mode === 'demo';
  const s = cfg.settings;
  const db = openDb(cfg, clock());
  const sms = options.sms || makeSms(cfg);
  const chat = options.chat || makeChat(cfg, { env: options.env || process.env, log, knowledgeFile: options.chatFile });
  const tyreList = options.tyres || readTyres(options.tyresFile || path.join(cfg.root, 'config', 'tyres.json'));
  const secure = !!cfg.publicBaseUrl && cfg.publicBaseUrl.startsWith('https:');
  const hk = v => crypto.createHmac('sha256', cfg.appSecret).update(v).digest('base64url');
  const staffAccounts = makeStaff(cfg, hk);
  const offsite = makeOffsite(options.offsite !== undefined ? options.offsite : offsiteSettings(options.env || process.env), { now: clock, fetch: options.fetch });
  if (demo && !getMeta(db, 'demo_seeded')) seedDemo(db, cfg, clock(), { staff: staffAccounts });
  staffAccounts.disableClashes(db, clock(), log);

  // sessions and remembered staff browsers carry this; a new PIN makes every one of them invalid
  const pinTag = hk('pin|' + cfg.staffPin).slice(0, 22);
  if (getMeta(db, 'pin_tag') !== pinTag) {
    // a new PIN: every staff device signs in afresh, and any lock-out from wrong tries is released
    db.q("DELETE FROM sessions WHERE kind = 'staff'").run();
    db.q('DELETE FROM devices').run();
    db.q("DELETE FROM throttle WHERE key LIKE 'pin:%'").run();
    setMeta(db, 'pin_tag', pinTag);
  }
  // set when the SMS service refuses a request, so that for the next two minutes every caller hears the same thing
  let smsDownUntil = 0;
  const names = store.serviceNames(cfg);
  const rule = (key, l) => ({ key, limit: l.limit, windowMs: l.windowMs });
  const tooMany = (ms, what) => new HttpError(429, 'slow-down', `${what} Try again in ${minutes(ms)}.`, { retryAfterMs: ms });
  let warnedProxy = false;

  function clientIp(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (cfg.trustProxy > 0 && fwd.length >= cfg.trustProxy) return normaliseIp(fwd[fwd.length - cfg.trustProxy]);
    if (cfg.trustProxy === 0 && fwd.length && !warnedProxy) {
      warnedProxy = true;
      log('warning: requests are arriving through a proxy but TRUST_PROXY is 0, so every visitor looks like one address. Set TRUST_PROXY=1 if the host puts one proxy in front of this server.');
    }
    return normaliseIp(req.socket.remoteAddress);
  }

  // the address links and QR codes are built on. On a live site this is always the configured one.
  function baseFor(req) {
    if (cfg.publicBaseUrl) return cfg.publicBaseUrl;
    const host = String(req.headers.host || '');
    return /^([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?$/i.test(host) ? `http://${host}` : `http://127.0.0.1:${cfg.port}`;
  }

  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  const cookie = (name, value, maxAgeMs) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
  const tokenOk = t => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);

  // who: for a staff session, the account that signed in ({ id, name }); the owner has id null
  function newSession(c, kind, phone, ttl, who) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.q('INSERT INTO sessions (token_hash, kind, phone, tag, created_at, last_seen, expires_at, staff_id, staff_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha(token), kind, phone, kind === 'staff' ? pinTag : null, c.now, c.now, c.now + ttl, who ? who.id : null, who ? who.name : null);
    c.setCookies.push(cookie(kind === 'staff' ? 'hta_s' : 'hta_c', token, ttl));
  }

  function readSession(c, kind) {
    const token = c.cookies[kind === 'staff' ? 'hta_s' : 'hta_c'];
    if (!tokenOk(token)) return null;
    const row = db.q('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?').get(sha(token), kind);
    if (!row || row.expires_at <= c.now) return null;
    if (kind === 'staff') {
      // a staff session also ends after half an hour without anyone touching the page
      if (row.tag !== pinTag || c.now - row.last_seen > STAFF_IDLE) return null;
      if (!c.passive && c.now - row.last_seen > MIN) db.q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(c.now, row.token_hash);
    }
    return row;
  }

  // a browser that signed in to the staff page with the current PIN at some point in the last 90 days
  function knownDevice(c) {
    const token = c.cookies.hta_d;
    if (!tokenOk(token)) return null;
    const row = db.q('SELECT * FROM devices WHERE token_hash = ?').get(sha(token));
    return row && row.tag === pinTag && row.expires_at > c.now ? row : null;
  }

  const needCustomer = c => {
    const sess = readSession(c, 'customer');
    if (!sess) throw new HttpError(401, 'signed-out', 'Please sign in again.');
    return sess;
  };
  const needPassport = c => {
    const sess = needCustomer(c);
    const customer = store.customerByPhone(db, sess.phone);
    if (!customer) throw new HttpError(404, 'no-passport', 'There is no tyre passport on this number yet.');
    return { sess, customer };
  };
  const staffView = (c, customerId) => {
    const customer = customerId == null ? null : store.customerById(db, customerId);
    return customer ? store.passportFor(db, cfg, customer, c.now, { staff: true, base: c.base }) : null;
  };
  const customerOr404 = id => {
    const customer = store.customerById(db, id);
    if (!customer) throw new HttpError(404, 'not-found', 'That customer was not found.');
    return customer;
  };

  /* ---------- routes ---------- */

  const routes = [];
  const route = (method, pattern, opts, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>\\d{1,12})') + '$'), opts, fn });

  route('GET', '/api/public/config', {}, () => ({
    mode: cfg.mode,
    shopName: s.shop.name,
    whatsapp: s.shop.whatsapp,
    shops: s.shops.map(({ id, name, phone, address, lat, lng }) => ({ id, name, phone, address, lat, lng })),
    signIn: demo ? 'demo' : sms.ready ? 'sms' : 'off',
    referral: s.rewards.referral.maxPerYear > 0 ? { service: names.get(s.rewards.referral.service) } : null,
    // the demo PIN and sample numbers exist only in demo mode
    demo: demo ? { staffPin: cfg.staffPin, staff: DEMO_STAFF, samples: DEMO_SAMPLES } : undefined,
  }));

  // the tyres the Compare page puts side by side, as the owner listed them
  route('GET', '/api/public/tyres', {}, () => tyreList);

  /* ---------- the chat assistant ---------- */

  route('GET', '/api/chat/config', {}, () => ({
    name: chat.knowledge.name,
    greeting: chat.knowledge.greeting,
    quick: chat.knowledge.quick,
    note: chat.knowledge.offline_note,
    ai: chat.mode === 'claude',
    whatsapp: s.shop.whatsapp,
  }));

  // the conversation so far comes from the page each time: nothing a visitor types is kept here
  // each answer the server gives carries a short signature; only answers it really gave are trusted as history
  const chatSig = text => hk('chat|' + text).slice(0, 22);
  const chatTurns = v => {
    const bad = new Invalid('messages', 'Type a message of up to 600 characters.');
    if (!Array.isArray(v) || v.length < 1 || v.length > CHAT_TURNS) throw bad;
    const out = v.map((m, i) => {
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.text !== 'string') throw bad;
      const role = i % 2 === 0 ? 'user' : 'assistant';
      if (m.role !== role) throw bad;
      if (m.sig !== undefined && (typeof m.sig !== 'string' || m.sig.length > 40)) throw bad;
      const max = role === 'user' ? CHAT_USER_MAX : CHAT_REPLY_MAX;
      if (m.text.length > max * 4) throw bad;
      const text = tidy(m.text);
      if (text.length < 1 || text.length > max) throw bad;
      return role === 'assistant' ? { role, text, sig: m.sig } : { role, text };
    });
    if (out[out.length - 1].role !== 'user') throw bad;
    return out;
  };
  route('POST', '/api/chat', { body: () => ({ messages: need(chatTurns, 'Type a message.') }) }, async c => {
    const gate = throttle.allow(db, [rule('chat:ip:' + c.ipKey, LIMITS.chatIp), rule('chat:d:' + c.ipKey, LIMITS.chatIpDay)], c.now);
    if (!gate.ok) throw tooMany(gate.retryAfterMs, 'The assistant is busy.');
    const { messages } = c.body;
    const last = messages[messages.length - 1].text;
    // an answer the visitor altered or made up is not history: the question stands alone then
    const history = messages.every(m => m.role !== 'assistant' || m.sig === chatSig(m.text)) ? messages.map(({ role, text }) => ({ role, text })) : [{ role: 'user', text: last }];
    // the ceiling for everyone together guards the model's bill: past it, the built-in answerer takes over
    const useModel = chat.mode === 'claude' && throttle.allow(db, [rule('chat:all', LIMITS.chatAll)], c.now).ok;
    const out = useModel ? await chat.answer(history) : { text: chat.local(last), source: 'local' };
    return { text: out.text, source: out.source, sig: chatSig(out.text) };
  });

  /* ---------- customer sign-in: phone number, one-time code, and one thing only the buyer has ---------- */

  route('POST', '/api/auth/request', { body: () => ({ phone: need(is.phone({ demo }), 'Enter your mobile number.'), ref: opt(is.referralCode('ref')) }) }, async c => {
    if (!demo && !sms.ready) throw new HttpError(503, 'sign-in-off', 'Sign-in by code is not switched on yet. Please call the shop.');
    const { phone, ref } = c.body, pk = hk('phone|' + phone);

    // A code goes only to a number staff have registered, or to a friend arriving on a customer's invitation.
    // Everyone gets the same answer either way, so the form cannot be used to find out who is a customer.
    const customer = store.customerByPhone(db, phone);
    const referrer = !customer && ref && s.rewards.referral.maxPerYear > 0 ? store.referrerByCode(db, ref) : null;
    let invited = !customer && ((!!referrer && referrer.phone !== phone) || !!db.q('SELECT 1 FROM referrals WHERE friend_phone = ? AND converted_at IS NULL').get(phone));

    // the same limits for every caller, whoever the number belongs to
    const own = [rule('otp:gap:' + pk, LIMITS.otpGap), rule('otp:p:' + pk, LIMITS.otpPhone), rule('otp:d:' + pk, LIMITS.otpPhoneDay)];
    const gate = throttle.allow(db, [rule('otp:ip:' + c.ipKey, LIMITS.otpIp), ...own], c.now);
    if (!gate.ok) throw tooMany(gate.retryAfterMs, 'Too many codes have been asked for.');

    // the spending guard and a failing SMS service also answer everyone alike, customer or not
    const cap = { key: 'otp:all', limit: cfg.smsHourlyCap, windowMs: HOUR };
    const failed = () => new HttpError(502, 'sms-failed', 'We could not ask for a code just now. Please try again in a few minutes, or call the shop.');
    if (!demo && (c.now < smsDownUntil || throttle.waitFor(db, cap, c.now))) {
      throttle.refund(db, own);
      throw failed();
    }

    // an invited friend draws on a small budget of its own; once that is used up the number is treated like any stranger
    const invite = [rule('otp:inv:' + pk, LIMITS.otpInvite), rule('otp:inv:all', LIMITS.otpInviteAll)];
    if (invited && !throttle.allow(db, invite, c.now).ok) invited = false;

    if (!customer && !invited) {
      if (demo) return { ok: true, wait: 60, demo: { code: null } };
      if (options.jitter !== false) await sleep(250 + crypto.randomInt(500));
      return { ok: true, wait: 60 };
    }

    // six digits, no leading zero; only a keyed hash is stored. An earlier code is cancelled only once the
    // new one is really on its way, so a refused request does not take away a code the customer already holds.
    const code = String(crypto.randomInt(100000, 1000000));
    const hash = hk(`otp|${phone}|${code}`);
    db.q('INSERT INTO otp_codes (phone_key, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)').run(pk, hash, c.now + OTP_TTL, c.now);
    const cancelEarlier = () => db.q('UPDATE otp_codes SET used_at = ? WHERE phone_key = ? AND used_at IS NULL AND code_hash <> ?').run(c.now, pk, hash);
    if (demo) { cancelEarlier(); return { ok: true, wait: 60, demo: { code } }; }

    throttle.allow(db, [cap], c.now);
    const sent = await sms.sendOtp(phone, code);
    if (!sent.ok) {
      // nothing was asked of the phone company, so nothing is claimed. The phone's own allowance is handed
      // back; the address's is not, so a failing service cannot be hammered for free.
      db.q('DELETE FROM otp_codes WHERE phone_key = ? AND code_hash = ?').run(pk, hash);
      throttle.refund(db, [...own, cap, ...(invited ? invite : [])]);
      smsDownUntil = clock() + 2 * MIN;
      setMeta(db, 'sms_error', JSON.stringify({ at: clock(), reason: sent.reason }));
      log(`sms: request refused (${sent.reason})`);
      throw failed();
    }
    cancelEarlier();
    setMeta(db, 'sms_ok_at', String(clock()));
    return { ok: true, wait: 60 };
  });

  route('POST', '/api/auth/verify', {
    body: () => ({ phone: need(is.phone({ demo }), 'Enter your mobile number.'), code: need(is.code, 'Enter the 6 digit code.'), plate: opt(is.plateTail('plate')), sale: opt(is.token('sale')), ref: opt(is.referralCode('ref')) }),
  }, c => {
    const { phone, code, plate, sale, ref } = c.body, pk = hk('phone|' + phone);
    const gate = throttle.allow(db, [rule('ver:ip:' + c.ipKey, LIMITS.verifyIp)], c.now);
    if (!gate.ok) throw tooMany(gate.retryAfterMs, 'Too many tries.');
    const paused = () => new HttpError(429, 'ask-counter', 'Sign-in for this number is paused after three wrong tries. Ask at the counter: staff can show you a QR code to scan, and that lets you in.');
    const pausedMs = throttle.lockedFor(db, 'plate:' + pk, c.now);

    const bad = new HttpError(400, 'bad-code', 'That code is not right, or it has expired. Check it, or ask for a new one.');
    const row = db.q('SELECT * FROM otp_codes WHERE phone_key = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1').get(pk, c.now);
    if (!row) throw bad;
    const want = Buffer.from(row.code_hash), got = Buffer.from(hk(`otp|${phone}|${code}`));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      const tries = row.tries + 1;
      db.q('UPDATE otp_codes SET tries = ?, used_at = ? WHERE id = ?').run(tries, tries >= OTP_TRIES ? c.now : null, row.id);
      throw bad;
    }

    /* The code is right, which proves who holds the number today. Numbers change hands and tyres last years, so
       a passport also needs one thing only the buyer has: the QR code on the bill, or the last four characters
       of the vehicle number. Three wrong tries pause sign-in for the number until staff sort it out. */
    const customer = store.customerByPhone(db, phone);
    let focus = null;
    if (customer) {
      const bySale = sale ? db.q('SELECT vehicle_id AS id FROM sales WHERE token = ? AND customer_id = ?').get(sale, customer.id) : null;
      if (bySale) focus = bySale.id;   // the QR code from the bill, or from the staff screen: this also lifts a pause
      else {
        if (pausedMs) throw paused();
        const byPlate = plate ? db.q('SELECT id FROM vehicles WHERE customer_id = ? AND substr(reg_no, -4) = ? LIMIT 1').get(customer.id, plate) : null;
        if (!byPlate) {
          if (!plate) throw new HttpError(400, 'need-plate', 'Enter the last 4 characters of your vehicle number as well.');
          const hit = throttle.strike(db, 'plate:' + pk, PLATE_LOCK, c.now);
          if (hit.lockedMs) throw paused();
          throw new HttpError(400, 'bad-plate', `Those characters do not match the vehicle on this passport. ${hit.left} ${hit.left === 1 ? 'try' : 'tries'} left.`, { left: hit.left });
        }
        focus = byPlate.id;
      }
      throttle.clear(db, 'plate:' + pk);
    }

    db.q('UPDATE otp_codes SET used_at = ? WHERE id = ?').run(c.now, row.id);
    // on a shop phone or tablet a customer's sign-in lasts fifteen minutes, not thirty days
    const shopDevice = !!knownDevice(c);
    newSession(c, 'customer', phone, shopDevice ? CUSTOMER_TTL_SHOP_DEVICE : CUSTOMER_TTL);
    if (ref) {
      const referrer = store.referrerByCode(db, ref);
      if (referrer) store.linkReferral(db, cfg, phone, referrer, c.now);
    }
    audit(db, c.now, 'customer', 'customer.signin', customer ? { customer: customer.id } : null);
    return { ok: true, focusVehicleId: focus, shortSession: shopDevice };
  });

  route('POST', '/api/auth/signout', { body: () => ({ everywhere: opt(is.bool('everywhere')) }) }, c => {
    const sess = readSession(c, 'customer');
    if (sess) {
      if (c.body.everywhere) db.q("DELETE FROM sessions WHERE kind = 'customer' AND phone = ?").run(sess.phone);
      else db.q('DELETE FROM sessions WHERE token_hash = ?').run(sess.token_hash);
    }
    c.setCookies.push(cookie('hta_c', '', 0));
    return { ok: true };
  });

  /* ---------- the customer's own passport ---------- */

  route('GET', '/api/me', {}, c => {
    const sess = readSession(c, 'customer');
    if (!sess) return { signedIn: false };
    const customer = store.customerByPhone(db, sess.phone);
    if (!customer) {
      const invited = !!db.q('SELECT 1 FROM referrals WHERE friend_phone = ? AND converted_at IS NULL').get(sess.phone);
      return { signedIn: true, hasPassport: false, phoneLast4: sess.phone.slice(-4), invited, referralService: names.get(s.rewards.referral.service) };
    }
    return { signedIn: true, hasPassport: true, freshSignIn: c.now - sess.created_at <= REAUTH_WINDOW, ...store.passportFor(db, cfg, customer, c.now, { base: c.base }) };
  });

  route('POST', '/api/me/reminders', { body: () => ({ on: need(is.bool('on'), 'Choose on or off.') }) }, c => {
    const { customer } = needPassport(c);
    return { ok: true, reminders: store.setReminders(db, cfg, customer, c.body.on, 'customer', c.now) === 'on' ? 'yes' : 'stopped' };
  });

  // the call itself is a plain phone link on the page; this only tells the shop where the customer is
  route('POST', '/api/me/breakdown', {
    body: () => ({ lat: opt(is.coord('lat', 90)), lng: opt(is.coord('lng', 180)), accuracyM: opt(is.metres('accuracyM')), vehicleId: opt(is.int('vehicleId', 1, 1e12, 'the vehicle')) }),
  }, c => {
    const { customer } = needPassport(c);
    const { lat, lng, accuracyM, vehicleId } = c.body;
    if ((lat == null) !== (lng == null)) throw new Invalid('lat', 'That location is not valid.');
    if (vehicleId != null && !db.q('SELECT 1 FROM vehicles WHERE id = ? AND customer_id = ?').get(vehicleId, customer.id)) throw new Invalid('vehicleId', 'That vehicle is not on this passport.');
    const gate = throttle.allow(db, [rule('bd:gap:' + customer.id, LIMITS.breakdownGap), rule('bd:day:' + customer.id, LIMITS.breakdownDay)], c.now);
    const near = est.nearestShop(s.shops, lat, lng);
    const shop = { id: near.shop.id, name: near.shop.name, phone: near.shop.phone };
    if (!gate.ok) {
      // The first tap often goes out before the phone has found itself. A location that arrives within ten
      // minutes is added to that breakdown, and it is shown to staff as new again.
      const first = lat == null ? null : db.q('SELECT id FROM breakdowns WHERE customer_id = ? AND lat IS NULL AND created_at > ? ORDER BY id DESC LIMIT 1').get(customer.id, c.now - LIMITS.breakdownGap.windowMs);
      if (!first) return { ok: true, shared: false, repeat: true, shop };
      db.q('UPDATE breakdowns SET lat = ?, lng = ?, accuracy_m = ?, shop_id = ?, seen_at = NULL WHERE id = ?').run(lat, lng, accuracyM, near.shop.id, first.id);
      return { ok: true, shared: true, repeat: false, shop, km: Math.round(near.km * 10) / 10 };
    }
    db.q('INSERT INTO breakdowns (customer_id, vehicle_id, lat, lng, accuracy_m, shop_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(customer.id, vehicleId, lat, lng, accuracyM, near.shop.id, c.now);
    audit(db, c.now, 'customer', 'breakdown.create', { customer: customer.id });
    return { ok: true, shared: lat != null, repeat: false, shop, km: near.km == null ? null : Math.round(near.km * 10) / 10 };
  });

  // deleting needs a sign-in less than ten minutes old, so a phone left unlocked cannot wipe a warranty record
  route('POST', '/api/me/delete', { body: () => ({ confirm: need(is.oneOf('confirm', ['DELETE']), 'Type DELETE to confirm.') }) }, c => {
    const sess = needCustomer(c);
    if (c.now - sess.created_at > REAUTH_WINDOW) throw new HttpError(403, 'reauth', 'For your safety, sign in again and then delete within ten minutes.');
    const customer = store.customerByPhone(db, sess.phone);
    if (customer) store.deleteCustomer(db, customer, 'customer', c.now);
    else tx(db, () => { db.q('DELETE FROM referrals WHERE friend_phone = ?').run(sess.phone); db.q('DELETE FROM sessions WHERE phone = ?').run(sess.phone); });
    db.q('DELETE FROM otp_codes WHERE phone_key = ?').run(hk('phone|' + sess.phone));
    db.checkpoint();
    c.setCookies.push(cookie('hta_c', '', 0));
    return { ok: true };
  });

  /* ---------- staff ---------- */

  route('POST', '/api/staff/login', { body: () => ({ pin: need(is.pin, 'Enter the staff PIN.') }) }, c => {
    const device = knownDevice(c);
    const keys = device ? [['pin:dev:' + device.token_hash.slice(0, 22), PIN_LOCK_DEVICE], ['pin:devday:' + device.token_hash.slice(0, 22), PIN_LOCK_DAY]] : [['pin:ip:' + c.ipKey, PIN_LOCK_IP], ['pin:all', PIN_LOCK_ALL], ['pin:day', PIN_LOCK_DAY]];
    const locked = Math.max(...keys.map(([k]) => throttle.lockedFor(db, k, c.now)));
    if (locked) throw new HttpError(429, 'locked', `Too many wrong PINs. Try again in ${minutes(locked)}.`, { retryAfterMs: locked });

    const who = staffAccounts.match(db, c.body.pin);
    if (!who) {
      const hits = keys.map(([k, lock]) => throttle.strike(db, k, lock, c.now));
      const lockedMs = Math.max(...hits.map(h => h.lockedMs)), left = Math.min(...hits.map(h => h.left));
      setMeta(db, 'pin_wrong', String(Number(getMeta(db, 'pin_wrong') || 0) + 1));
      audit(db, c.now, 'unknown', 'staff.pin.wrong', null);
      if (lockedMs) throw new HttpError(429, 'locked', `Too many wrong PINs. Try again in ${minutes(lockedMs)}.`, { retryAfterMs: lockedMs });
      throw new HttpError(401, 'wrong-pin', `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { left });
    }

    // wrong tries are not forgiven by a right PIN: a member of staff cannot reset the count by signing in as themselves
    newSession(c, 'staff', null, STAFF_TTL, who);
    staffAccounts.touch(db, who.id, c.now);
    // remember this browser, so wrong PINs typed elsewhere can never lock the shop's own devices out
    const token = crypto.randomBytes(32).toString('base64url');
    if (device) db.q('DELETE FROM devices WHERE token_hash = ?').run(device.token_hash);
    db.q('INSERT INTO devices (token_hash, tag, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), pinTag, c.now, c.now + DEVICE_TTL);
    c.setCookies.push(cookie('hta_d', token, DEVICE_TTL));
    const wrongSince = Number(getMeta(db, 'pin_wrong') || 0);
    if (who.role === 'owner') setMeta(db, 'pin_wrong', '0');   // only the owner's own sign-in resets the count they are shown
    audit(db, c.now, who.role === 'owner' ? 'owner' : 'staff:' + who.name, 'staff.login', null);
    return { ok: true, wrongSince, who: { name: who.name, role: who.role } };
  });

  route('POST', '/api/staff/logout', { staff: true, body: () => ({}) }, c => {
    db.q('DELETE FROM sessions WHERE token_hash = ?').run(c.staff.token_hash);
    c.setCookies.push(cookie('hta_s', '', 0));
    return { ok: true };
  });

  // what the staff page needs to draw itself, and the health of the things an owner would otherwise not notice
  route('GET', '/api/staff/status', { staff: true }, c => {
    const smsError = JSON.parse(getMeta(db, 'sms_error') || 'null'), smsOkAt = Number(getMeta(db, 'sms_ok_at') || 0);
    return {
      mode: cfg.mode,
      today: c.today,
      services: [...names].map(([key, name]) => ({ key, name })),
      warrantyMonths: s.warranty.defaultMonths,
      referralOn: s.rewards.referral.maxPerYear > 0,
      tyres: db.q('SELECT tyre FROM sales GROUP BY tyre ORDER BY MAX(id) DESC LIMIT 40').all().map(r => r.tyre),
      signIn: demo ? 'demo' : sms.ready ? 'sms' : 'off',
      smsError: smsError && smsError.at > smsOkAt ? smsError : null,
      database: { since: Number(getMeta(db, 'created_at') || 0), customers: db.q('SELECT COUNT(*) AS n FROM customers').get().n, backupAt: Number(getMeta(db, 'backup_at') || 0) || null },
      breakdownsUnseen: db.q('SELECT COUNT(*) AS n FROM breakdowns WHERE seen_at IS NULL').get().n,
      who: { name: c.staff.staff_id == null ? 'Owner' : c.staff.staff_name, role: c.staff.staff_id == null ? 'owner' : 'staff' },
      lowStock: stock.low(db).length,
      seenAs: c.ip,
    };
  });

  route('POST', '/api/staff/sales', {
    staff: true,
    body: c => ({
      phone: need(is.phone({ demo }), "Enter the customer's mobile number."),
      regNo: need(is.regNo('regNo'), 'Enter the vehicle number.'),
      tyre: need(is.text('tyre', 2, 80, 'the tyre brand and model'), 'Enter the tyre brand and model.'),
      size: need(is.size('size'), 'Enter the tyre size.'),
      qty: need(is.int('qty', 1, 24, 'the number of tyres'), 'Enter how many tyres were fitted.'),
      odometerKm: need(is.int('odometerKm', 0, 3000000, 'the odometer reading in km'), 'Enter the odometer reading.'),
      fittedOn: opt(is.day('fittedOn', c.today, 3660, 'the fitting date')),
      billNo: opt(is.billNo('billNo')),
      amount: opt(is.rupees('amount')),
      warrantyMonths: opt(is.int('warrantyMonths', 0, 120, 'the warranty in months')),
      newTreadMm: opt(is.mm('newTreadMm', 2, 30, 'the new tread depth')),
      remindersOk: opt(is.bool('remindersOk')),
      referralCode: opt(is.referralCode('referralCode')),
      confirm: opt(is.bool('confirm')),
      idem: opt(is.idem('idem')),
    }),
  }, c => {
    const { amount, ...rest } = c.body;
    // a counted size comes off the shelf count, in the same transaction as the sale; the desk is told when
    // that leaves it low. A sale typed in from an old bill does not touch today's shelf.
    let shelf = null;
    const recent = !rest.fittedOn || est.toDay(c.today) - est.toDay(rest.fittedOn) <= 7;
    const done = store.registerSale(db, cfg, { ...rest, amountPaise: amount }, c.now, { by: c.actor, onSaved: saleId => { if (recent) shelf = stock.onSale(db, { id: saleId, size: rest.size, qty: rest.qty }, c.actor, c.now); } });
    const { token, ...out } = done;
    return { ...out, stock: shelf, passportUrl: `${c.base}/passport/#s=${token}`, customer: staffView(c, done.customerId) };
  });

  route('POST', '/api/staff/sales/:id/void', { staff: true, body: () => ({}) }, c => {
    let shelf = null;
    const done = store.voidSale(db, c.params.id, c.now, c.actor, { before: sale => { shelf = stock.onVoid(db, sale, c.actor, c.now); } });
    return { ok: true, ...(shelf ? { stock: shelf } : {}), customer: staffView(c, done.customerId) };
  });

  route('POST', '/api/staff/visits', {
    staff: true,
    body: c => ({
      vehicleId: need(is.int('vehicleId', 1, 1e12, 'the vehicle'), 'Choose the vehicle.'),
      odometerKm: opt(is.int('odometerKm', 0, 3000000, 'the odometer reading in km')),
      treadMm: opt(is.mm('treadMm', 0, 30, 'the tread depth')),
      services: opt(is.keys('services', names, 10)),
      visitedOn: opt(is.day('visitedOn', c.today, 60, 'the visit date')),
      confirm: opt(is.bool('confirm')),
      idem: opt(is.idem('idem')),
    }),
  }, c => {
    const done = store.logVisit(db, cfg, c.body, c.now, { by: c.actor });
    return { ...done, customer: staffView(c, done.customerId) };
  });

  // a POST, although it only reads: phone and vehicle numbers must not travel in an address, where proxies log them
  route('POST', '/api/staff/lookup', { staff: true, body: () => ({ q: need(is.lookup('q'), 'Type at least 3 characters of the vehicle number, or 4 digits of the phone number.') }) }, c =>
    ({ results: store.lookup(db, c.body.q) }));

  route('GET', '/api/staff/customers/:id', { staff: true }, c => ({ customer: staffView(c, customerOr404(c.params.id).id) }));

  // staff can record a yes given at the counter, and can always stop. Only the customer can restart after a stop.
  route('POST', '/api/staff/customers/:id/reminders', { staff: true, body: () => ({ on: need(is.bool('on'), 'Choose on or off.') }) }, c => {
    const customer = customerOr404(c.params.id);
    const done = store.setReminders(db, cfg, customer, c.body.on, 'staff', c.now);
    if (done === 'stopped') throw new HttpError(409, 'stopped', 'This customer stopped reminders. Only they can turn them back on, from their own passport.');
    return { ok: true, customer: staffView(c, customer.id) };
  });

  // a customer without a smartphone can ask at the counter. The last four digits guard against the wrong row.
  route('POST', '/api/staff/customers/:id/delete', { staff: true, body: () => ({ last4: need(is.text('last4', 4, 4, 'the last 4 digits of the phone number'), 'Type the last 4 digits of the phone number.') }) }, c => {
    const customer = customerOr404(c.params.id);
    if (c.body.last4 !== customer.phone.slice(-4)) throw new Invalid('last4', 'Those are not the last 4 digits of this phone number.');
    store.deleteCustomer(db, customer, c.actor, c.now);
    db.q('DELETE FROM otp_codes WHERE phone_key = ?').run(hk('phone|' + customer.phone));
    db.checkpoint();
    return { ok: true };
  });

  route('POST', '/api/staff/vehicles/:id', { staff: true, body: () => ({ regNo: need(is.regNo('regNo'), 'Enter the vehicle number.') }) }, c =>
    ({ ok: true, customer: staffView(c, store.renameVehicle(db, c.params.id, c.body.regNo, c.now, c.actor)) }));

  route('POST', '/api/staff/grants/:id/use', { staff: true, body: () => ({}) }, c => ({ ok: true, customer: staffView(c, store.useGrant(db, c.params.id, c.now, c.actor)) }));
  route('POST', '/api/staff/grants/:id/unuse', { staff: true, body: () => ({}) }, c => ({ ok: true, customer: staffView(c, store.unuseGrant(db, c.params.id, c.now, c.actor)) }));

  route('GET', '/api/staff/due', { staff: true }, c => ({ today: c.today, leadDays: s.reminders.replacementLeadDays, items: dueItems(db, cfg, c.now, c.base) }));

  // records what the person at the shop did. The server never marks anything sent on its own.
  route('POST', '/api/staff/reminders', {
    staff: true,
    body: () => ({ key: need(is.text('key', 6, 80, 'the reminder'), 'Choose a reminder.'), status: need(is.oneOf('status', ['opened', 'marked_sent', 'skipped']), 'Choose what was done.') }),
  }, c => {
    const item = markReminder(db, cfg, c.body.key, c.body.status, c.now, c.base);
    if (!item) throw new HttpError(409, 'not-due', 'That reminder is no longer due, or the customer has not agreed to reminders.');
    audit(db, c.now, 'staff', 'reminder.' + c.body.status, { customer: item.customerId });
    return { ok: true, item };
  });

  route('GET', '/api/staff/breakdowns', { staff: true }, c => ({
    items: db.q(`SELECT b.id, b.created_at AS at, b.lat, b.lng, b.accuracy_m AS accuracyM, b.shop_id AS shopId, b.seen_at AS seenAt, b.customer_id AS customerId, b.vehicle_id AS vehicleId, c.phone, v.reg_no AS regNo
                 FROM breakdowns b JOIN customers c ON c.id = b.customer_id LEFT JOIN vehicles v ON v.id = b.vehicle_id
                 WHERE b.created_at > ? ORDER BY b.id DESC LIMIT 50`).all(c.now - 7 * DAY_MS),
  }));
  route('POST', '/api/staff/breakdowns/:id/seen', { staff: true, body: () => ({}) }, c => {
    db.q('UPDATE breakdowns SET seen_at = ? WHERE id = ? AND seen_at IS NULL').run(c.now, c.params.id);
    return { ok: true };
  });

  // QR codes are images, so they come back as SVG rather than JSON
  route('GET', '/api/staff/qr', { staff: true, raw: true }, c => {
    const saleId = c.url.searchParams.get('sale');
    let target = `${c.base}/passport/`, label = 'QR code for the tyre passport';
    if (saleId != null) {
      const sale = /^\d{1,12}$/.test(saleId) ? db.q('SELECT token FROM sales WHERE id = ?').get(Number(saleId)) : null;
      if (!sale) throw new HttpError(404, 'not-found', 'That sale was not found.');
      // the token rides in the part after #, which browsers never send to a server, so it stays out of logs
      target += '#s=' + sale.token;
      label = 'QR code for this tyre passport';
    }
    return { type: 'image/svg+xml', body: qrSvg(target, label), headers: { 'content-security-policy': "default-src 'none'" } };
  });

  /* ---------- the job card for the fitter ---------- */

  route('GET', '/api/staff/sales/:id/job', { staff: true }, c => {
    const sale = db.q('SELECT s.*, v.reg_no, cu.phone FROM sales s JOIN vehicles v ON v.id = s.vehicle_id JOIN customers cu ON cu.id = s.customer_id WHERE s.id = ?').get(c.params.id);
    if (!sale) throw new HttpError(404, 'not-found', 'That sale was not found.');
    const shop = s.shops[0];
    return {
      shop: { name: s.shop.name, phone: shop.phone, address: shop.address, whatsapp: s.shop.whatsapp },
      sale: { id: sale.id, billNo: sale.bill_no, fittedOn: sale.fitted_on, tyre: sale.tyre, size: sale.size, qty: sale.qty, odometerKm: sale.odometer_km, newTreadMm: sale.new_tread_mm, warrantyMonths: sale.warranty_months, enteredBy: sale.entered_by, enteredAt: sale.created_at },
      vehicle: { regNo: sale.reg_no },
      customer: { phoneTail: sale.phone.slice(-4) },
      profile: est.profileFor(sale.size, s.tyres).key,
      services: [...names].map(([key, name]) => ({ key, name })),
      printedBy: c.actor === 'owner' ? 'Owner' : c.actor.replace(/^staff:/, ''),
      now: c.now,
    };
  });

  /* ---------- counting without cookies ---------- */

  route('POST', '/api/stat', { body: () => ({ k: need(v => { if (!stats.okKey(v)) throw new Invalid('k', 'Not a known count.'); return v; }, 'Nothing to count.') }) }, c => {
    if (!throttle.allow(db, [rule('stat:ip:' + c.ipKey, LIMITS.stat)], c.now).ok) return { ok: true };   // over the limit the count is simply dropped
    stats.bump(db, c.today, c.body.k);
    return { ok: true };
  });

  /* ---------- the owner's page ---------- */

  const asIs = field => v => v;
  const owner = { staff: true, owner: true };
  const problem = (field, message) => { throw new Invalid(field, message); };

  route('GET', '/api/admin/overview', owner, c => overview(db, cfg, c.now));

  route('GET', '/api/admin/staff', owner, () => ({ staff: staffAccounts.list(db) }));
  route('POST', '/api/admin/staff', { ...owner, body: () => ({ name: need(asIs('name'), 'Enter the name.'), pin: need(asIs('pin'), 'Choose a PIN of 6 to 12 digits.') }) }, c =>
    ({ member: staffAccounts.create(db, c.body, c.actor, c.now) }));
  route('POST', '/api/admin/staff/:id', { ...owner, body: () => ({ name: opt(asIs('name')), pin: opt(asIs('pin')), active: opt(is.bool('active')) }) }, c => {
    const { name, pin, active } = c.body;
    if (name == null && pin == null && active == null) problem('name', 'Nothing to change.');
    let member = staffAccounts.byId(db, c.params.id);
    if (!member) throw new HttpError(404, 'not-found', 'That account was not found.');
    if (name != null) member = staffAccounts.rename(db, c.params.id, name, c.actor, c.now);
    if (pin != null) member = staffAccounts.resetPin(db, c.params.id, pin, c.actor, c.now);
    if (active != null) member = staffAccounts.setActive(db, c.params.id, active, c.actor, c.now);
    return { member };
  });

  route('GET', '/api/admin/stock', owner, c => stock.list(db, cfg, c.now));
  route('POST', '/api/admin/stock', { ...owner, body: () => ({ size: need(asIs('size'), 'Enter the tyre size.'), qty: need(asIs('qty'), 'Enter the count.'), minQty: opt(asIs('minQty')) }) }, c =>
    ({ row: stock.count(db, c.body, c.actor, c.now) }));
  route('POST', '/api/admin/stock/remove', { ...owner, body: () => ({ size: need(is.size('size'), 'Enter the tyre size.') }) }, c => stock.remove(db, c.body.size, c.actor, c.now));
  route('POST', '/api/admin/stock/moves', { ...owner, body: () => ({ size: need(is.size('size'), 'Enter the tyre size.') }) }, c => ({ moves: stock.moves(db, stock.keyOf(c.body.size)) }));

  // the range rides in the path, not after a ?, like every other API address the pages use
  route('GET', '/api/admin/stats/:days', owner, c => {
    if (![7, 30, 90].includes(c.params.days)) throw new HttpError(400, 'invalid', 'The range must be 7, 30 or 90 days.');
    return stats.summary(db, cfg, c.now, c.params.days);
  });

  // the old customer book, a few rows at a time
  route('POST', '/api/admin/import', { ...owner, body: () => ({ rows: need(v => { if (!Array.isArray(v) || v.length < 1 || v.length > IMPORT_BATCH) throw new Invalid('rows', `Send between 1 and ${IMPORT_BATCH} rows at a time.`); return v; }, 'Nothing to import.') }) }, c => {
    const results = importRows(db, cfg, c.body.rows, c.actor, c.now);
    audit(db, c.now, c.actor, 'import.batch', { rows: results.length, added: results.filter(r => r.ok && !r.duplicate).length });
    db.checkpoint();
    return { results };
  });

  // copies of the database: the daily one beside it, and the one sent off-site
  const backupStatus = () => {
    const dir = path.join(cfg.dataDir, 'backups');
    const files = demo || !fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter(f => /^passport-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().reverse()
      .map(f => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size }));
    return {
      demo,
      database: demo ? null : { file: db.file, bytes: fs.existsSync(db.file) ? fs.statSync(db.file).size : 0, customers: db.q('SELECT COUNT(*) AS n FROM customers').get().n },
      local: { dir: demo ? null : dir, lastAt: Number(getMeta(db, 'backup_at') || 0) || null, files },
      offsite: {
        configured: offsite.ready,
        where: offsite.describe(),
        lastAt: Number(getMeta(db, 'offsite_at') || 0) || null,
        lastName: getMeta(db, 'offsite_name'),
        lastError: getMeta(db, 'offsite_error'),
        lastTriedAt: Number(getMeta(db, 'offsite_tried_at') || 0) || null,
      },
    };
  };
  async function sendOffsite(file, now) {
    setMeta(db, 'offsite_tried_at', String(now));
    try {
      const out = await offsite.upload(file, path.basename(file));
      setMeta(db, 'offsite_at', String(now));
      setMeta(db, 'offsite_name', out.key);
      setMeta(db, 'offsite_day', new Date(now).toISOString().slice(0, 10));
      db.q("DELETE FROM meta WHERE key = 'offsite_error'").run();
      return out;
    } catch (e) {
      setMeta(db, 'offsite_error', String(e.message).slice(0, 200));
      log('off-site backup failed: ' + e.message);
      throw e;
    }
  }
  route('GET', '/api/admin/backup', owner, () => backupStatus());
  route('POST', '/api/admin/backup/now', { ...owner, body: () => ({}) }, async c => {
    if (demo) throw new HttpError(400, 'demo', 'The demo keeps its sample data in memory; there is no database file to copy.');
    const today = new Date(c.now).toISOString().slice(0, 10);
    const target = path.join(cfg.dataDir, 'backups', `passport-${today}.sqlite`);
    if (fs.existsSync(target)) fs.unlinkSync(target);   // today's copy is taken afresh
    db.checkpoint();
    const file = backup(db, cfg, c.now);
    audit(db, c.now, c.actor, 'backup.now', null);
    let sent = null, error = null;
    if (offsite.ready) { try { sent = await sendOffsite(file, c.now); } catch (e) { error = e.message; } }
    return { ok: true, file: path.basename(file), sent, error, status: backupStatus() };
  });
  // a current copy to keep somewhere else; it holds every customer, so the download is written to the audit log
  route('GET', '/api/admin/backup/download', { ...owner, raw: true }, c => {
    const dir = path.join(cfg.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(c.now).toISOString().replace(/[:.]/g, '-');
    const tmp = path.join(dir, `download-${stamp}.sqlite`);
    db.checkpoint();
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const body = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    audit(db, c.now, c.actor, 'backup.download', { bytes: body.length });
    const name = `${demo ? 'demo-sample' : 'passport'}-${stamp.slice(0, 10)}.sqlite`;
    return { type: 'application/vnd.sqlite3', body, headers: { 'content-disposition': `attachment; filename="${name}"`, 'content-length': body.length } };
  });

  /* ---------- plumbing ---------- */

  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length'] || 0) > BODY_CAP) return reject(new HttpError(413, 'too-large', 'That request is too large.'));
      let size = 0;
      const chunks = [];
      req.on('data', chunk => {
        size += chunk.length;
        if (size > BODY_CAP) { reject(new HttpError(413, 'too-large', 'That request is too large.')); req.removeAllListeners('data'); req.resume(); }
        else chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => reject(new HttpError(400, 'bad-request', 'That request could not be read.')));
    });
  }

  // a request that changes something must be our own page talking to us: JSON, our header, and our origin
  function ownPage(req, c) {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return false;
    if (req.headers['x-hta'] !== '1') return false;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return false;
    const origin = req.headers.origin;
    return !origin || origin === c.base;
  }

  function sendJson(res, c, status, body, extra) {
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra };
    if (c && c.setCookies.length) headers['set-cookie'] = c.setCookies;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  function sendError(res, c, e) {
    if (e instanceof Invalid) return sendJson(res, c, 400, { error: { code: 'invalid', field: e.field, message: e.message } });
    if (e instanceof store.Problem) return sendJson(res, c, 409, { error: { code: 'problem', field: e.field, message: e.message, ...e.extra } });
    if (e instanceof HttpError) {
      const extra = e.extra && e.extra.retryAfterMs ? { 'retry-after': String(Math.ceil(e.extra.retryAfterMs / 1000)) } : undefined;
      return sendJson(res, c, e.status, { error: { code: e.code, message: e.message, ...e.extra } }, extra);
    }
    log('error: ' + (e && e.stack ? e.stack : e));
    return sendJson(res, c, 500, { error: { code: 'server', message: 'Something went wrong on our side. Please try again.' } });
  }

  async function api(req, res, url) {
    const c = { req, res, url, now: clock(), cookies: parseCookies(req), setCookies: [], passive: req.headers['x-hta-passive'] === '1', staff: null };
    try {
      c.ip = clientIp(req);
      c.ipKey = hk('ip|' + c.ip).slice(0, 22);
      c.today = store.todayFor(cfg, c.now);
      c.base = baseFor(req);

      const hits = routes.map(r => ({ r, m: r.re.exec(url.pathname) })).filter(x => x.m);
      if (!hits.length) throw new HttpError(404, 'not-found', 'There is nothing at this address.');
      const hit = hits.find(x => x.r.method === req.method);
      if (!hit) throw new HttpError(405, 'method', 'That method is not allowed here.');
      const { r, m } = hit;

      c.staff = readSession(c, 'staff');
      // the name written against everything this request changes
      c.actor = c.staff ? (c.staff.staff_id == null ? 'owner' : 'staff:' + c.staff.staff_name) : 'customer';
      const gate = throttle.allow(db, [c.staff ? rule('api:s:' + c.staff.token_hash.slice(0, 22), LIMITS.staffApi) : rule('api:ip:' + c.ipKey, LIMITS.api)], c.now);
      if (!gate.ok) throw tooMany(gate.retryAfterMs, 'Too many requests.');
      if (r.opts.staff && !c.staff) throw new HttpError(401, 'staff-signed-out', 'Enter the staff PIN to continue.');
      if (r.opts.owner && c.staff.staff_id != null) throw new HttpError(403, 'owner-only', 'This page is for the owner. Sign in with the owner PIN.');

      c.params = {};
      for (const [k, v] of Object.entries(m.groups || {})) c.params[k] = Number(v);
      if (req.method !== 'GET') {
        if (!ownPage(req, c)) throw new HttpError(403, 'forbidden', 'This request did not come from the site.');
        let parsed;
        try { parsed = JSON.parse((await readBody(req)) || '{}'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'bad-json', 'That request could not be read.'); }
        c.body = shape(parsed, r.opts.body(c));
      }

      const out = await r.fn(c);
      if (r.opts.raw) {
        res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...out.headers });
        return res.end(out.body);
      }
      return sendJson(res, c, 200, out);
    } catch (e) {
      return sendError(res, c, e);
    }
  }

  function baseHeaders(appPage) {
    const h = { 'x-content-type-options': 'nosniff' };
    if (secure) h['strict-transport-security'] = 'max-age=31536000';
    if (appPage) Object.assign(h, { 'content-security-policy': APP_CSP, 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'permissions-policy': 'geolocation=(self), camera=(), microphone=()', 'cache-control': 'no-store' });
    return h;
  }

  function staticFile(pathname) {
    let p;
    try { p = decodeURIComponent(pathname); } catch { return null; }
    if (PAGES.has(p)) return PAGES.get(p);
    const parts = p.split('/').filter(Boolean);
    if (parts.length < 2 || !ASSET_DIRS.has(parts[0])) return null;
    // plain names only: no dot files, no "..", nothing Windows would read as a stream or device
    if (!parts.every(seg => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(seg) && !seg.endsWith('.'))) return null;
    if (!MIME[path.extname(p).toLowerCase()]) return null;
    return parts.join('/');
  }

  function serveStatic(req, res, url) {
    if (['/passport', '/staff', '/privacy', '/tyres', '/admin', '/staff/job', '/compare'].includes(url.pathname)) {
      res.writeHead(308, { location: url.pathname + '/' + url.search, ...baseHeaders(false) });
      return res.end();
    }
    const rel = staticFile(url.pathname);
    const notFound = () => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...baseHeaders(false) }); res.end('Not found'); };
    if (!rel) return notFound();
    const file = path.join(cfg.root, rel);
    if (!file.startsWith(cfg.root + path.sep)) return notFound();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound();
      // pages, styles and scripts are checked against the server each time (a cheap 304), so a fix is live at once;
      // pictures, fonts and film can be kept for a day
      const appPage = APP_PAGES.has(rel), fresh = !rel.startsWith('assets/');
      const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const headers = { 'content-type': MIME[path.extname(rel).toLowerCase()], 'last-modified': st.mtime.toUTCString(), etag, 'accept-ranges': 'bytes', 'cache-control': fresh ? 'no-cache' : 'public, max-age=86400', ...baseHeaders(appPage) };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }

      // video needs byte ranges to seek and to play at all on some phones
      let start = 0, end = st.size - 1, status = 200;
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (range && (range[1] || range[2]) && st.size > 0) {
        if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
        else start = Math.max(0, st.size - Number(range[2]));
        if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}`, ...baseHeaders(false) }); return res.end(); }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
      }
      headers['content-length'] = st.size === 0 ? 0 : end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || st.size === 0) return res.end();
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  }

  /* The stop link in a reminder message. It works without scripts, in any in-app browser: a page with one
     button, and the button posts a plain form. Opening the link changes nothing (link previews fetch it), and
     the page says the same thing whether or not the link is still good, so it gives nothing away. */
  async function stopLink(req, res, url) {
    const page = (status, html) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...baseHeaders(true) }); res.end(html); };
    const m = /^\/stop\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
    if (req.method === 'GET' || req.method === 'HEAD') return m ? page(200, pages.stopAsk(m[1], demo)) : page(404, pages.stopBroken(demo));
    if (req.method !== 'POST' || url.pathname !== '/stop') { res.writeHead(405, baseHeaders(false)); return res.end(); }
    const now = clock();
    if (!throttle.allow(db, [rule('stop:ip:' + hk('ip|' + clientIp(req)).slice(0, 22), LIMITS.stopIp)], now).ok) return page(429, pages.stopBusy(demo));
    let token = '';
    try { token = new URLSearchParams(await readBody(req)).get('t') || ''; } catch { /* treated as an unknown link */ }
    const customer = /^[A-Za-z0-9_-]{16,64}$/.test(token) ? db.q('SELECT * FROM customers WHERE stop_token = ?').get(token) : null;
    if (customer && customer.reminders_ok) store.setReminders(db, cfg, customer, false, 'customer', now);
    return page(200, pages.stopDone(demo));
  }

  function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400); return res.end(); }
    // behind a proxy that reports plain http, send browsers to the secure address before anything else
    if (secure && cfg.trustProxy > 0 && req.headers['x-forwarded-proto'] === 'http' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(308, { location: cfg.publicBaseUrl + url.pathname + url.search });
      return res.end();
    }
    // A demo nobody asked for (the keys went missing, behind a tunnel or a proxy on the same machine) answers
    // only on this computer. On any other address the pages load but show no sample customer and no demo PIN.
    const dynamic = url.pathname.startsWith('/api/') || url.pathname === '/stop' || url.pathname.startsWith('/stop/');
    if (demo && !cfg.demoByName && dynamic && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(String(req.headers.host || ''))) {
      return sendJson(res, null, 503, { error: { code: 'not-set-up', message: 'The tyre passport is not set up on this address yet.' } });
    }
    if (url.pathname.startsWith('/api/')) return void api(req, res, url);
    if (url.pathname === '/stop' || url.pathname.startsWith('/stop/')) return void stopLink(req, res, url).catch(() => res.destroy());
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD', ...baseHeaders(false) }); return res.end(); }
    return serveStatic(req, res, url);
  }

  // called at start and every few hours: clears what has expired, and takes the daily copy of a live database
  function housekeeping() {
    const now = clock();
    const out = sweep(db, cfg, now);
    stats.sweep(db, cfg, now);
    stock.sweepMoves(db, now);
    db.checkpoint();
    let file = null;
    try { file = backup(db, cfg, now); } catch (e) { log('backup failed: ' + e.message); }
    // once a day the copy goes off-site as well; a failure is tried again at the next round
    if (file && offsite.ready && getMeta(db, 'offsite_day') !== new Date(now).toISOString().slice(0, 10)) {
      out.offsite = sendOffsite(file, now).then(() => true, () => false);
    }
    return out;
  }

  return { cfg, db, sms, chat, staff: staffAccounts, offsite, handler, housekeeping, close: () => db.close() };
}

module.exports = { createApp, normaliseIp, LIMITS, HttpError };
