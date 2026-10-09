'use strict';

/* Settings for the tyre passport server.
   Secrets come only from the environment (the host's settings, or a local .env that is never served).
   Everything a shop owner edits lives in config/passport.json. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEMO_PIN = '246810';
// the sample staff PINs the demo shows on its sign-in screen. Like the demo PIN they are printed in this code,
// so a live site refuses them, for the owner and for every member of staff.
const DEMO_STAFF_PINS = ['135790', '864209'];
const SECRET_KEYS = ['STAFF_PIN', 'APP_SECRET', 'MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID'];

class ConfigError extends Error {}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const need = (ok, msg) => { if (!ok) throw new ConfigError('config/passport.json: ' + msg); };
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const KEY = /^[a-z][a-z0-9-]{1,39}$/;

// obvious PINs are refused: one repeated digit, a straight run, a short repeated block, or a date
function weakPin(pin) {
  if (/^(\d)\1+$/.test(pin)) return true;
  if ('01234567890123456789'.includes(pin) || '98765432109876543210'.includes(pin)) return true;
  for (const n of [2, 3, 4, 5, 6]) if (pin.length > n && pin.length % n === 0 && pin === pin.slice(0, n).repeat(pin.length / n)) return true;
  const dm = (d, m) => +d >= 1 && +d <= 31 && +m >= 1 && +m <= 12;
  const year = y => +y >= 1930 && +y <= 2035;
  if (pin.length === 6 && (dm(pin.slice(0, 2), pin.slice(2, 4)) || dm(pin.slice(4, 6), pin.slice(2, 4)))) return true;            // DDMMYY, YYMMDD
  if (pin.length === 8 && ((dm(pin.slice(0, 2), pin.slice(2, 4)) && year(pin.slice(4))) || (year(pin.slice(0, 4)) && dm(pin.slice(6, 8), pin.slice(4, 6))))) return true;
  return pin === DEMO_PIN;
}

function checkSettings(s) {
  need(isObj(s), 'the file must be one JSON object');

  need(isObj(s.shop), '"shop" is missing');
  need(str(s.shop.name, 2, 80), '"shop.name" must be 2 to 80 characters');
  need(typeof s.shop.whatsapp === 'string' && /^[1-9]\d{9,14}$/.test(s.shop.whatsapp), '"shop.whatsapp" must be digits with the country code and no plus sign, for example 918303400005');
  need(int(s.shop.utcOffsetMinutes, -720, 840), '"shop.utcOffsetMinutes" must be a whole number of minutes, 330 for India');

  need(Array.isArray(s.shops) && s.shops.length >= 1 && s.shops.length <= 50, '"shops" must list between 1 and 50 shops');
  const shopIds = new Set();
  s.shops.forEach((shop, i) => {
    const at = `"shops[${i}]"`;
    need(isObj(shop), `${at} must be an object`);
    need(typeof shop.id === 'string' && KEY.test(shop.id) && !shopIds.has(shop.id), `${at}.id must be a unique short name in lower case, for example "ludhiana"`);
    shopIds.add(shop.id);
    need(str(shop.name, 2, 80), `${at}.name must be 2 to 80 characters`);
    need(typeof shop.phone === 'string' && /^\+[1-9]\d{9,14}$/.test(shop.phone), `${at}.phone must start with + and the country code, for example +918303400005`);
    need(str(shop.address, 2, 160), `${at}.address must be 2 to 160 characters`);
    need(num(shop.lat, -90, 90) && num(shop.lng, -180, 180), `${at} needs "lat" and "lng" as numbers`);
  });

  const r = s.rewards;
  need(isObj(r), '"rewards" is missing');
  need(Array.isArray(r.services) && r.services.length >= 1 && r.services.length <= 20, '"rewards.services" must list between 1 and 20 services');
  const serviceKeys = new Set();
  r.services.forEach((sv, i) => {
    need(isObj(sv) && typeof sv.key === 'string' && KEY.test(sv.key) && !serviceKeys.has(sv.key), `"rewards.services[${i}].key" must be a unique short name in lower case`);
    serviceKeys.add(sv.key);
    need(str(sv.name, 2, 60), `"rewards.services[${i}].name" must be 2 to 60 characters`);
  });
  need(int(r.cardVisits, 1, 50), '"rewards.cardVisits" must be a whole number from 1 to 50');
  need(Array.isArray(r.card) && r.card.length >= 1 && r.card.length <= 20, '"rewards.card" must list between 1 and 20 steps');
  const steps = new Set();
  r.card.forEach((step, i) => {
    need(isObj(step) && int(step.atVisit, 1, r.cardVisits) && !steps.has(step.atVisit), `"rewards.card[${i}].atVisit" must be a visit number from 1 to cardVisits (${r.cardVisits}), used once`);
    steps.add(step.atVisit);
    need(serviceKeys.has(step.service), `"rewards.card[${i}].service" must be one of the keys in rewards.services`);
  });
  need(isObj(r.referral) && serviceKeys.has(r.referral.service), '"rewards.referral.service" must be one of the keys in rewards.services');
  need(int(r.referral.maxPerYear, 0, 100), '"rewards.referral.maxPerYear" must be a whole number from 0 to 100');

  const t = s.tyres;
  need(isObj(t), '"tyres" is missing');
  need(int(t.maxAgeYears, 1, 15), '"tyres.maxAgeYears" must be 1 to 15');
  need(int(t.minKmForReadings, 500, 50000), '"tyres.minKmForReadings" must be 500 to 50000');
  need(Array.isArray(t.profiles) && t.profiles.length >= 1 && t.profiles.length <= 10, '"tyres.profiles" must list between 1 and 10 profiles');
  const profileKeys = new Set();
  t.profiles.forEach((p, i) => {
    const at = `"tyres.profiles[${i}]"`;
    need(isObj(p) && typeof p.key === 'string' && KEY.test(p.key) && !profileKeys.has(p.key), `${at}.key must be a unique short name in lower case`);
    profileKeys.add(p.key);
    need(typeof p.sizeMatch === 'string' && p.sizeMatch.length <= 200, `${at}.sizeMatch must be text (leave it empty to match every size)`);
    try { new RegExp(p.sizeMatch, 'i'); } catch { need(false, `${at}.sizeMatch is not a valid pattern`); }
    need(num(p.legalMinMm, 0.5, 5), `${at}.legalMinMm must be between 0.5 and 5`);
    need(num(p.replaceAtMm, p.legalMinMm, 6), `${at}.replaceAtMm must be from legalMinMm up to 6`);
    need(num(p.newTreadMm, p.replaceAtMm + 1, 30), `${at}.newTreadMm must be more than replaceAtMm + 1 and at most 30`);
    need(int(p.typicalLifeKm, 5000, 300000), `${at}.typicalLifeKm must be 5000 to 300000`);
    need(int(p.typicalMonthlyKm, 50, 30000), `${at}.typicalMonthlyKm must be 50 to 30000`);
  });
  need(t.profiles[t.profiles.length - 1].sizeMatch === '', 'the last entry in "tyres.profiles" must have an empty sizeMatch so every size has a profile');

  const m = s.reminders;
  need(isObj(m), '"reminders" is missing');
  need(int(m.replacementLeadDays, 1, 180), '"reminders.replacementLeadDays" must be 1 to 180');
  need(int(m.serviceLeadDays, 0, 90), '"reminders.serviceLeadDays" must be 0 to 90');
  need(Array.isArray(m.services) && m.services.length <= 10, '"reminders.services" must be a list of up to 10 services');
  const remKeys = new Set();
  m.services.forEach((sv, i) => {
    const at = `"reminders.services[${i}]"`;
    need(isObj(sv) && typeof sv.key === 'string' && KEY.test(sv.key) && !remKeys.has(sv.key), `${at}.key must be a unique short name in lower case`);
    remKeys.add(sv.key);
    need(str(sv.name, 2, 60), `${at}.name must be 2 to 60 characters`);
    need(int(sv.everyKm, 500, 200000), `${at}.everyKm must be 500 to 200000`);
    need(int(sv.everyMonths, 1, 60), `${at}.everyMonths must be 1 to 60`);
    need(sv.for === undefined || (Array.isArray(sv.for) && sv.for.length >= 1 && sv.for.every(k => profileKeys.has(k))), `${at}.for must list keys from tyres.profiles, or be left out to apply to every tyre`);
  });

  need(isObj(s.warranty) && int(s.warranty.defaultMonths, 0, 120), '"warranty.defaultMonths" must be 0 to 120');
  need(typeof s.warranty.policyUrl === 'string' && /^https:\/\/[^\s"<>]{4,200}$/.test(s.warranty.policyUrl), '"warranty.policyUrl" must be an https link');

  need(isObj(s.privacy) && int(s.privacy.deleteAfterInactiveYears, 1, 20), '"privacy.deleteAfterInactiveYears" must be 1 to 20');
  need(typeof s.privacy.noticeVersion === 'string' && /^[\w.-]{1,20}$/.test(s.privacy.noticeVersion), '"privacy.noticeVersion" must be a short label such as 2026-10');
  return s;
}

function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new ConfigError(`cannot read ${file}`); }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new ConfigError(`config/passport.json is not valid JSON: ${e.message}`); }
  return checkSettings(parsed);
}

/* demo: no secret is set. An in-memory database with sample customers, clearly labelled, on this computer only.
   live: at least one secret is set. A database file that is never seeded. Anything missing is refused with a
   plain message; the server never falls back to demo data once any secret exists. The mode is fixed here, at
   start-up, and nothing in a request can change it. */
function loadConfig(env = process.env, opts = {}) {
  const has = k => typeof env[k] === 'string' && env[k].trim() !== '';
  if (has('PASSPORT_MODE') && !['demo', 'live'].includes(env.PASSPORT_MODE)) throw new ConfigError('PASSPORT_MODE must be "demo" or "live".');
  const live = SECRET_KEYS.some(has) || env.PASSPORT_MODE === 'live';
  if (env.PASSPORT_MODE === 'demo' && live) throw new ConfigError('PASSPORT_MODE=demo cannot be combined with live keys. Remove the keys or remove PASSPORT_MODE.');

  const cfg = {
    root: ROOT,
    mode: live ? 'live' : 'demo',
    demoByName: env.PASSPORT_MODE === 'demo',   // a demo somebody asked for, as opposed to one caused by missing keys
    port: 4173,
    host: env.HOST || (live ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: 0,          // how many proxies stand in front of this server
    publicBaseUrl: null,
    dataDir: has('DATA_DIR') ? path.resolve(ROOT, env.DATA_DIR.trim()) : path.join(ROOT, 'data'),
    appSecret: null,
    staffPin: DEMO_PIN,
    msg91: null,
    smsHourlyCap: 120,
    settings: opts.settings ? checkSettings(opts.settings) : readSettings(opts.settingsFile || path.join(ROOT, 'config', 'passport.json')),
  };

  if (has('PORT')) {
    const port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('PORT must be a port number.');
    cfg.port = port;
  }
  if (has('TRUST_PROXY')) {
    const hops = Number(env.TRUST_PROXY);
    if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new ConfigError('TRUST_PROXY must be the number of proxies in front of the server: 0 for none, 1 on most hosting platforms.');
    cfg.trustProxy = hops;
  }
  if (has('SMS_HOURLY_CAP')) {
    const cap = Number(env.SMS_HOURLY_CAP);
    if (!Number.isInteger(cap) || cap < 1 || cap > 100000) throw new ConfigError('SMS_HOURLY_CAP must be a whole number from 1 to 100000.');
    cfg.smsHourlyCap = cap;
  }
  if (has('PUBLIC_BASE_URL')) {
    let url;
    try { url = new URL(env.PUBLIC_BASE_URL.trim()); } catch { throw new ConfigError('PUBLIC_BASE_URL must be a full address such as https://passport.example.com'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username) throw new ConfigError('PUBLIC_BASE_URL must be only the site address, with no path.');
    if (live && url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new ConfigError('PUBLIC_BASE_URL must use https on a live site.');
    cfg.publicBaseUrl = url.origin;
  }

  if (!live) {
    // a real deployment that lost its keys must fail loudly, not quietly show sample customers to the public
    const local = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
    if (env.PASSPORT_MODE !== 'demo' && (!local || env.NODE_ENV === 'production')) {
      throw new ConfigError('No keys are set, so this address would show the sample customers. Set the live keys (see .env.example), or set PASSPORT_MODE=demo if a public demo is what you want.');
    }
    if (env.PASSPORT_MODE !== 'demo' && fs.existsSync(path.join(cfg.dataDir, 'passport.sqlite'))) {
      throw new ConfigError(`A live customer database exists at ${cfg.dataDir} but no keys are set. Put the keys back (see .env.example). To run the demo next to it on purpose, set PASSPORT_MODE=demo.`);
    }
    // a fresh secret each start is enough: the demo database lives in memory and dies with the process
    cfg.appSecret = crypto.randomBytes(32).toString('hex');
    return cfg;
  }

  if (!has('APP_SECRET') || env.APP_SECRET.trim().length < 32) throw new ConfigError('APP_SECRET is required on a live site: a random string of at least 32 characters.');
  if (!has('STAFF_PIN') || !/^\d{6,12}$/.test(env.STAFF_PIN.trim())) throw new ConfigError('STAFF_PIN is required on a live site: 6 to 12 digits (8 random digits is a good choice).');
  if (weakPin(env.STAFF_PIN.trim()) || DEMO_STAFF_PINS.includes(env.STAFF_PIN.trim())) throw new ConfigError('STAFF_PIN is too easy to guess. Avoid repeats, straight runs, dates and the demo PINs.');
  if (!cfg.publicBaseUrl) throw new ConfigError('PUBLIC_BASE_URL is required on a live site. Links in reminder messages and QR codes are built from it.');
  if (!has('DATA_DIR')) throw new ConfigError('DATA_DIR is required on a live site: a folder on a disk that survives restarts and redeploys. The customer database is kept there.');
  if (has('MSG91_AUTH_KEY') !== has('MSG91_TEMPLATE_ID')) throw new ConfigError('Set both MSG91_AUTH_KEY and MSG91_TEMPLATE_ID, or neither.');
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.accessSync(cfg.dataDir, fs.constants.W_OK);
  } catch { throw new ConfigError(`DATA_DIR (${cfg.dataDir}) cannot be written to.`); }

  cfg.appSecret = env.APP_SECRET.trim();
  cfg.staffPin = env.STAFF_PIN.trim();
  // without MSG91 the staff side works and customer sign-in says plainly that it is not switched on yet
  if (has('MSG91_AUTH_KEY')) cfg.msg91 = { authKey: env.MSG91_AUTH_KEY.trim(), templateId: env.MSG91_TEMPLATE_ID.trim() };
  return cfg;
}

module.exports = { loadConfig, checkSettings, weakPin, ConfigError, DEMO_PIN, DEMO_STAFF_PINS, ROOT, SECRET_KEYS };
