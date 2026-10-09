'use strict';

/* Unit tests for the pure and near-pure parts of the tyre passport server:
   server/config.js, server/validate.js, server/throttle.js and server/estimate.js.

   Run from the project folder:
     node --disable-warning=ExperimentalWarning --test test/unit.test.js

   No HTTP, no port, no sleeping and no real clock: every time is passed in.
   Live-mode settings point DATA_DIR at a fresh folder under the system temp folder. */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const { loadConfig, checkSettings, ConfigError } = require('../server/config');
const { Invalid, is, need, opt, shape, validDay } = require('../server/validate');
const throttle = require('../server/throttle');
const est = require('../server/estimate');
const { openDb } = require('../server/db');

const MIN = 60e3, HOUR = 3600e3;

/* ---------- helpers ---------- */

// one folder per run under the system temp folder; nothing outside it is written
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-'));
const tmpPath = name => path.join(TMP, name);
const DEMO_DIR = tmpPath('no-database-here');   // never created: the demo keeps nothing on disk
const LIVE_DIR = tmpPath('live');               // loadConfig makes the folder ready; no test here opens a database in it

const SETTINGS_FILE = path.join(ROOT, 'config', 'passport.json');
const readShipped = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
let shippedChecked = null;
const shipped = () => shippedChecked || (shippedChecked = checkSettings(readShipped()));

const demoEnv = (over = {}) => ({ DATA_DIR: DEMO_DIR, ...over });
const liveEnv = (over = {}) => ({
  APP_SECRET: 'x'.repeat(40),
  STAFF_PIN: '48151623',
  PUBLIC_BASE_URL: 'http://localhost:1',
  DATA_DIR: LIVE_DIR,
  MSG91_AUTH_KEY: 'k',
  MSG91_TEMPLATE_ID: 't',
  ...over,
});

// the server must refuse to start, with a ConfigError whose message a shop owner can act on
function refusesToStart(env, pattern, opts) {
  assert.throws(() => loadConfig(env, opts), err => {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got: ${err && err.stack}`);
    assert.match(err.message, pattern);
    return true;
  });
}

// a checker must throw Invalid (never a TypeError, never return) for this value
function refusesValue(check, value, field) {
  assert.throws(() => check(value), err => {
    assert.ok(err instanceof Invalid, `expected Invalid for ${util.inspect(value)}, got: ${err && err.stack}`);
    if (field !== undefined) assert.equal(err.field, field);
    assert.ok(err.message.length > 0, 'the refusal carries a message for the person');
    return true;
  }, `${util.inspect(value)} should be refused`);
}

// characters by number, so nothing invisible sits in this file
const cp = (...codes) => String.fromCodePoint(...codes);
// control characters, zero-width characters, direction overrides and the byte order mark
const hidden = ch => { const c = ch.codePointAt(0); return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || c === 0xfeff; };

/* =====================================================================================================
   server/config.js: demo or live
   ===================================================================================================== */

describe('config: demo or live is decided at start-up', () => {
  test('with no keys set it runs as a demo on this computer only, with the demo PIN', () => {
    const cfg = loadConfig(demoEnv());
    assert.equal(cfg.mode, 'demo');
    assert.equal(cfg.host, '127.0.0.1', 'the demo listens on this computer only');
    assert.equal(cfg.staffPin, '246810');
    assert.equal(cfg.msg91, null, 'no SMS provider in the demo');
    assert.match(cfg.appSecret, /^[0-9a-f]{64}$/, 'the demo makes up its own secret');
    assert.notEqual(loadConfig(demoEnv()).appSecret, cfg.appSecret, 'and a different one every start');
    assert.equal(cfg.settings.shop.name, readShipped().shop.name, 'settings come from config/passport.json');
  });

  test('a completely empty environment gives the demo', t => {
    if (fs.existsSync(path.join(ROOT, 'data', 'passport.sqlite'))) return t.skip('a live database exists in ./data, so the demo is rightly refused here');
    assert.equal(loadConfig({}).mode, 'demo');
  });

  test('keys left blank count as not set, so .env.example copied as it is still gives the demo', () => {
    assert.equal(loadConfig(demoEnv({ APP_SECRET: '', STAFF_PIN: '   ', MSG91_AUTH_KEY: '', MSG91_TEMPLATE_ID: '' })).mode, 'demo');
    const example = util.parseEnv(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
    for (const key of ['STAFF_PIN', 'APP_SECRET', 'MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID']) assert.equal(example[key], '', `${key} ships blank in .env.example`);
    assert.equal(loadConfig({ ...example, DATA_DIR: DEMO_DIR }).mode, 'demo');
  });

  test('any one of the four keys switches to live, and a half-set live site is refused instead of showing sample data', () => {
    for (const key of ['STAFF_PIN', 'APP_SECRET', 'MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID']) {
      const env = demoEnv({ [key]: key === 'STAFF_PIN' ? '48151623' : 'x'.repeat(40) });
      let cfg = null;
      assert.throws(() => { cfg = loadConfig(env); }, ConfigError, `${key} alone must not start anything`);
      assert.equal(cfg, null);
    }
  });

  test('a complete live configuration starts live with exactly the secrets it was given', () => {
    const env = liveEnv({ DATA_DIR: tmpPath('fresh-live') });
    assert.equal(fs.existsSync(env.DATA_DIR), false);
    const cfg = loadConfig(env);
    assert.equal(cfg.mode, 'live');
    assert.equal(cfg.host, '0.0.0.0', 'a live site listens for the public');
    assert.equal(cfg.appSecret, env.APP_SECRET);
    assert.equal(cfg.staffPin, '48151623');
    assert.notEqual(cfg.staffPin, '246810');
    assert.equal(cfg.publicBaseUrl, 'http://localhost:1');
    assert.equal(cfg.dataDir, path.resolve(env.DATA_DIR));
    assert.deepEqual(cfg.msg91, { authKey: 'k', templateId: 't' });
    assert.ok(fs.statSync(env.DATA_DIR).isDirectory(), 'the data folder is made ready');
  });

  test('an https address is kept as the bare site address', () => {
    assert.equal(loadConfig(liveEnv({ PUBLIC_BASE_URL: 'https://passport.example.com/' })).publicBaseUrl, 'https://passport.example.com');
  });

  test('live without the two MSG91 keys still starts, with SMS sign-in off', () => {
    const cfg = loadConfig(liveEnv({ MSG91_AUTH_KEY: undefined, MSG91_TEMPLATE_ID: undefined }));
    assert.equal(cfg.mode, 'live');
    assert.equal(cfg.msg91, null);
  });

  test('live refuses a missing or short APP_SECRET', () => {
    refusesToStart(liveEnv({ APP_SECRET: undefined }), /APP_SECRET/);
    refusesToStart(liveEnv({ APP_SECRET: '' }), /APP_SECRET/);
    refusesToStart(liveEnv({ APP_SECRET: 'x'.repeat(31) }), /APP_SECRET/);
    assert.equal(loadConfig(liveEnv({ APP_SECRET: 'x'.repeat(32) })).mode, 'live');
  });

  test('live refuses a missing STAFF_PIN and one that is not 6 to 12 digits', () => {
    for (const pin of [undefined, '', '48151', '4815162342108', '4815a623', '48 15 16', '-4815162']) {
      refusesToStart(liveEnv({ STAFF_PIN: pin }), /STAFF_PIN/);
    }
  });

  test('live refuses PINs that are easy to guess: repeats, straight runs, repeated blocks, dates and the demo PIN', () => {
    const weak = {
      '111111': 'one digit repeated',
      '00000000': 'one digit repeated',
      '123456': 'a run up',
      '987654': 'a run down',
      '34567890': 'a run up',
      '121212': 'a block of two repeated',
      '123123': 'a block of three repeated',
      '48154815': 'a block of four repeated',
      '150847': 'a date, day month year',
      '470815': 'a date, year month day',
      '15081947': 'a date with a four digit year',
      '19470815': 'a date, year first',
      '06102026': 'today as a date',
      '246810': 'the demo PIN',
      '135790': 'a sample staff PIN from the demo, printed in the code',
      '864209': 'the other sample staff PIN from the demo',
    };
    for (const [pin, why] of Object.entries(weak)) {
      assert.throws(() => loadConfig(liveEnv({ STAFF_PIN: pin })), err => err instanceof ConfigError && /STAFF_PIN is too easy to guess/.test(err.message), `${pin} (${why}) must be refused`);
    }
    for (const pin of ['48151623', '739204', '905317462']) assert.equal(loadConfig(liveEnv({ STAFF_PIN: pin })).staffPin, pin, `${pin} is a fair PIN`);
  });

  test('a longer PIN that is one block typed twice is refused too', () => {
    // blocks of five and six digits: a straight run typed twice, and random digits typed twice
    for (const pin of ['1234512345', '123456123456', '987654987654', '4815148151', '739204739204']) {
      assert.throws(() => loadConfig(liveEnv({ STAFF_PIN: pin })), err => err instanceof ConfigError && /STAFF_PIN is too easy to guess/.test(err.message), `${pin} must be refused`);
    }
    // ten and twelve digits that are not a repeat are still fair PINs
    for (const pin of ['4815162342', '481516234210', '7392046185']) assert.equal(loadConfig(liveEnv({ STAFF_PIN: pin })).staffPin, pin, `${pin} is a fair PIN`);
  });

  test('live refuses a missing PUBLIC_BASE_URL, one with a path, and plain http on a public address', () => {
    refusesToStart(liveEnv({ PUBLIC_BASE_URL: undefined }), /PUBLIC_BASE_URL is required/);
    refusesToStart(liveEnv({ PUBLIC_BASE_URL: 'passport.example.com' }), /PUBLIC_BASE_URL/);
    refusesToStart(liveEnv({ PUBLIC_BASE_URL: 'https://example.com/passport' }), /PUBLIC_BASE_URL/);
    refusesToStart(liveEnv({ PUBLIC_BASE_URL: 'https://example.com/?shop=1' }), /PUBLIC_BASE_URL/);
    refusesToStart(liveEnv({ PUBLIC_BASE_URL: 'ftp://example.com' }), /PUBLIC_BASE_URL/);
    refusesToStart(liveEnv({ PUBLIC_BASE_URL: 'http://passport.example.com' }), /https/);
  });

  test('live refuses a missing DATA_DIR, so customer records are never kept somewhere that is wiped on redeploy', () => {
    refusesToStart(liveEnv({ DATA_DIR: undefined }), /DATA_DIR is required/);
    refusesToStart(liveEnv({ DATA_DIR: '  ' }), /DATA_DIR is required/);
  });

  test('one MSG91 key without the other is refused', () => {
    refusesToStart(liveEnv({ MSG91_TEMPLATE_ID: undefined }), /MSG91_AUTH_KEY and MSG91_TEMPLATE_ID/);
    refusesToStart(liveEnv({ MSG91_AUTH_KEY: undefined }), /MSG91_AUTH_KEY and MSG91_TEMPLATE_ID/);
  });

  test('PASSPORT_MODE cannot turn a keyed site into a demo, and cannot make a live site out of nothing', () => {
    refusesToStart(liveEnv({ PASSPORT_MODE: 'demo' }), /PASSPORT_MODE=demo cannot be combined with live keys/);
    refusesToStart(demoEnv({ PASSPORT_MODE: 'demo', STAFF_PIN: '48151623' }), /cannot be combined/);
    refusesToStart(demoEnv({ PASSPORT_MODE: 'test' }), /PASSPORT_MODE must be/);
    refusesToStart(demoEnv({ PASSPORT_MODE: 'live' }), /APP_SECRET/);
    assert.equal(loadConfig(liveEnv({ PASSPORT_MODE: 'live' })).mode, 'live');
  });

  test('with no keys, a public HOST or NODE_ENV=production is refused rather than showing sample customers', () => {
    refusesToStart(demoEnv({ HOST: '0.0.0.0' }), /sample customers/);
    refusesToStart(demoEnv({ HOST: '192.168.1.20' }), /sample customers/);
    refusesToStart(demoEnv({ HOST: '::' }), /sample customers/);
    refusesToStart(demoEnv({ NODE_ENV: 'production' }), /sample customers/);
    refusesToStart(demoEnv({ HOST: '127.0.0.1', NODE_ENV: 'production' }), /sample customers/);
    // this computer only is fine
    for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(loadConfig(demoEnv({ HOST: host })).mode, 'demo');
    assert.equal(loadConfig(demoEnv({ NODE_ENV: 'development' })).mode, 'demo');
  });

  test('a public demo is possible only by asking for it with PASSPORT_MODE=demo', () => {
    const cfg = loadConfig(demoEnv({ PASSPORT_MODE: 'demo', HOST: '0.0.0.0', NODE_ENV: 'production' }));
    assert.equal(cfg.mode, 'demo');
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.staffPin, '246810');
    assert.equal(cfg.demoByName, true);
  });

  test('a demo that was asked for is told apart from one caused by missing keys', () => {
    // the server uses this to keep a demo nobody asked for to this computer: on any other Host header it
    // answers 503 not-set-up instead of showing the sample customers
    assert.equal(loadConfig(demoEnv()).demoByName, false, 'no keys and no PASSPORT_MODE: nobody asked for this demo');
    assert.equal(loadConfig(demoEnv({ PASSPORT_MODE: '' })).demoByName, false, 'PASSPORT_MODE left blank is not asking');
    assert.equal(loadConfig(demoEnv({ HOST: 'localhost', NODE_ENV: 'development' })).demoByName, false);
    assert.equal(loadConfig(demoEnv({ PASSPORT_MODE: 'demo' })).demoByName, true);
    assert.equal(loadConfig(demoEnv({ PASSPORT_MODE: 'demo', HOST: '127.0.0.1' })).demoByName, true, 'asked for by name, wherever it listens');
    // a live site is never a demo of either kind
    assert.equal(loadConfig(liveEnv()).demoByName, false);
    assert.equal(loadConfig(liveEnv({ PASSPORT_MODE: 'live' })).demoByName, false);
    // and beside a live database the demo starts only when asked for by name, so it is always the named kind there
    const dir = tmpPath('lost-keys-named');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'passport.sqlite'), '');
    assert.equal(loadConfig({ DATA_DIR: dir, PASSPORT_MODE: 'demo' }).demoByName, true);
  });

  test('the demo refuses to start beside a live customer database whose keys have gone missing', () => {
    const dir = tmpPath('lost-keys');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'passport.sqlite'), '');
    refusesToStart({ DATA_DIR: dir }, /live customer database exists/);
    // on purpose is allowed: the demo is in memory and never opens that file
    assert.equal(loadConfig({ DATA_DIR: dir, PASSPORT_MODE: 'demo' }).mode, 'demo');
    // and with the keys back the same folder is a live site again
    assert.equal(loadConfig(liveEnv({ DATA_DIR: dir })).mode, 'live');
  });

  test('PORT, TRUST_PROXY and SMS_HOURLY_CAP must be sensible numbers', () => {
    const cfg = loadConfig(demoEnv({ PORT: '0', TRUST_PROXY: '1', SMS_HOURLY_CAP: '40' }));
    assert.deepEqual([cfg.port, cfg.trustProxy, cfg.smsHourlyCap], [0, 1, 40]);
    for (const port of ['abc', '70000', '80.5', '-1']) refusesToStart(demoEnv({ PORT: port }), /PORT/);
    for (const hops of ['6', '-1', 'yes', '1.5']) refusesToStart(demoEnv({ TRUST_PROXY: hops }), /TRUST_PROXY/);
    for (const cap of ['0', '-5', 'lots', '100001']) refusesToStart(demoEnv({ SMS_HOURLY_CAP: cap }), /SMS_HOURLY_CAP/);
  });

  test('npm test runs every test file with the SQLite warning switched off', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node --disable-warning=ExperimentalWarning --test');
    // the flag is one this Node accepts, and with it loading the database module prints no such warning
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "require('node:sqlite')"], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /ExperimentalWarning/);
  });
});

/* =====================================================================================================
   server/config.js: config/passport.json
   ===================================================================================================== */

// every value in the settings, as a path such as ['tyres', 'profiles', 2, 'newTreadMm']; notes (_readme ...) left out
function leafPaths(node, at = [], out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => leafPaths(v, [...at, i], out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) if (!(at.length === 0 && k.startsWith('_'))) leafPaths(v, [...at, k], out);
  } else out.push(at);
  return out;
}
const parentOf = (obj, p) => p.slice(0, -1).reduce((o, k) => o[k], obj);
const entryName = p => [...p].reverse().find(k => typeof k === 'string');
const show = p => p.map(k => (typeof k === 'number' ? `[${k}]` : `.${k}`)).join('').slice(1);

function refusesSettings(settings, patterns, label) {
  assert.throws(() => checkSettings(settings), err => {
    assert.ok(err instanceof ConfigError, `${label}: expected a ConfigError, got: ${err && err.stack}`);
    assert.match(err.message, /^config\/passport\.json: /, `${label}: the message says which file to fix`);
    for (const pattern of [].concat(patterns)) assert.match(err.message, pattern, label);
    return true;
  }, `${label} should be refused`);
}
// the message must point at the right part of the file: its section ("tyres...) and the entry itself (newTreadMm)
const namesEntry = p => [new RegExp(`"${p[0]}[.\\["]`), new RegExp(`\\b${entryName(p)}\\b`)];

describe('config: config/passport.json is checked before the server will start', () => {
  test('the shipped config/passport.json passes its own checks', () => {
    const s = shipped();
    assert.ok(s.shops.length >= 1);
    assert.equal(s.tyres.profiles[s.tyres.profiles.length - 1].sizeMatch, '', 'the last profile catches every size');
  });

  test('every entry is needed: removing any one is refused, and the message names it', () => {
    const paths = leafPaths(readShipped());
    assert.ok(paths.length > 40, 'the walk found the settings');
    for (const p of paths) {
      const s = readShipped();
      const parent = parentOf(s, p), key = p[p.length - 1];
      if (Array.isArray(parent)) parent.splice(key, 1); else delete parent[key];
      refusesSettings(s, namesEntry(p), `without ${show(p)}`);
    }
  });

  test('a number written as text, or text where a number belongs, is refused and never crashes the check', () => {
    for (const p of leafPaths(readShipped())) {
      const s = readShipped();
      const parent = parentOf(s, p), key = p[p.length - 1];
      parent[key] = typeof parent[key] === 'number' ? String(parent[key]) : 42;
      refusesSettings(s, namesEntry(p), `${show(p)} = ${util.inspect(parent[key])}`);
    }
    for (const junk of [null, undefined, [], 'passport', 7]) refusesSettings(junk, /one JSON object/, util.inspect(junk));
  });

  test('values that would make the passport misbehave are refused, each with a message naming the entry', () => {
    const cases = [
      ['a WhatsApp number with a plus sign', s => { s.shop.whatsapp = '+918303400005'; }, /shop\.whatsapp/],
      ['a time zone offset that is not whole minutes', s => { s.shop.utcOffsetMinutes = 5.5; }, /utcOffsetMinutes/],
      ['no shops for the breakdown button to call', s => { s.shops = []; }, /"shops"/],
      ['a shop phone without the country code', s => { s.shops[0].phone = '8303400005'; }, /shops\[0\]"\.phone/],
      ['a shop off the map', s => { s.shops[0].lat = 130.9; }, /"lat"/],
      ['two shops with the same id', s => { s.shops.push({ ...s.shops[0] }); }, /shops\[1\]"\.id/],
      ['a card step after the card has ended', s => { s.rewards.card[0].atVisit = s.rewards.cardVisits + 1; }, /atVisit/],
      ['two rewards at the same visit', s => { s.rewards.card[1].atVisit = s.rewards.card[0].atVisit; }, /atVisit/],
      ['a card reward that is not a listed service', s => { s.rewards.card[0].service = 'free-tyre'; }, /rewards\.card\[0\]\.service/],
      ['a referral reward that is not a listed service', s => { s.rewards.referral.service = 'free-tyre'; }, /rewards\.referral\.service/],
      ['a negative referral cap', s => { s.rewards.referral.maxPerYear = -1; }, /maxPerYear/],
      ['two services with the same key', s => { s.rewards.services[1].key = s.rewards.services[0].key; }, /rewards\.services\[1\]\.key/],
      ['tyres that never age', s => { s.tyres.maxAgeYears = 0; }, /maxAgeYears/],
      ['readings trusted after a few km', s => { s.tyres.minKmForReadings = 100; }, /minKmForReadings/],
      ['a size pattern that is not a valid pattern', s => { s.tyres.profiles[0].sizeMatch = '([2-4]'; }, /sizeMatch is not a valid pattern/],
      ['no catch-all profile at the end', s => { s.tyres.profiles[s.tyres.profiles.length - 1].sizeMatch = '^\\d{3}/'; }, /last entry/],
      ['a replacement depth below the legal limit', s => { s.tyres.profiles[0].replaceAtMm = s.tyres.profiles[0].legalMinMm - 0.1; }, /replaceAtMm/],
      ['a new tyre with no tread to wear', s => { s.tyres.profiles[0].newTreadMm = s.tyres.profiles[0].replaceAtMm; }, /newTreadMm/],
      ['a legal limit of nothing', s => { s.tyres.profiles[0].legalMinMm = 0; }, /legalMinMm/],
      ['a typical life of a few km', s => { s.tyres.profiles[0].typicalLifeKm = 400; }, /typicalLifeKm/],
      ['a service reminder for a tyre kind that does not exist', s => { s.reminders.services[0].for = ['tractor']; }, /reminders\.services\[0\]"\.for/],
      ['a service due every 100 km', s => { s.reminders.services[0].everyKm = 100; }, /everyKm/],
      ['a service that is never due by time', s => { s.reminders.services[0].everyMonths = 0; }, /everyMonths/],
      ['a replacement reminder with no lead time', s => { s.reminders.replacementLeadDays = 0; }, /replacementLeadDays/],
      ['a warranty link that is not https', s => { s.warranty.policyUrl = 'http://hindustantyreagencies.com/warranty'; }, /policyUrl/],
      ['a warranty of 121 months', s => { s.warranty.defaultMonths = 121; }, /defaultMonths/],
      ['customer data kept for ever', s => { s.privacy.deleteAfterInactiveYears = 0; }, /deleteAfterInactiveYears/],
      ['a privacy notice label with spaces', s => { s.privacy.noticeVersion = 'October 2026'; }, /noticeVersion/],
    ];
    for (const [label, breakIt, pattern] of cases) {
      const s = readShipped();
      breakIt(s);
      refusesSettings(s, pattern, label);
    }
  });

  test('sensible edits are accepted: referrals switched off, a service for every tyre, a second shop', () => {
    const s = readShipped();
    s.rewards.referral.maxPerYear = 0;
    delete s.reminders.services[0].for;
    s.shops.push({ id: 'jalandhar', name: 'Hindustan Tyre Agencies, Jalandhar', phone: '+918303400006', address: 'GT Road, Jalandhar, Punjab', lat: 31.326, lng: 75.5762 });
    assert.equal(checkSettings(s), s);
  });

  test('broken settings stop the server from starting in either mode', () => {
    const broken = readShipped();
    broken.rewards.card[0].service = 'free-tyre';
    refusesToStart(demoEnv(), /rewards\.card\[0\]\.service/, { settings: broken });
    refusesToStart(liveEnv(), /rewards\.card\[0\]\.service/, { settings: broken });
  });

  test('a passport.json that is missing or is not valid JSON is refused with a plain message', () => {
    const dir = tmpPath('settings');
    fs.mkdirSync(dir, { recursive: true });
    const half = path.join(dir, 'passport.json');
    fs.writeFileSync(half, '{ "shop": { "name": "Hindustan Tyre Agencies", ');
    refusesToStart(demoEnv(), /not valid JSON/, { settingsFile: half });
    refusesToStart(demoEnv(), /cannot read/, { settingsFile: path.join(dir, 'nowhere.json') });
  });
});

/* =====================================================================================================
   server/validate.js
   ===================================================================================================== */

describe('validate: phone numbers', () => {
  const demoPhone = is.phone({ demo: true });
  const livePhone = is.phone();

  test('the demo takes only made-up numbers starting 555, however they are typed', () => {
    for (const typed of ['5550000199', '55500 00199', '555-000-0199', '+91 55500 00199', '915550000199', '05550000199', '(555) 000.0199']) {
      assert.equal(demoPhone(typed), '+915550000199', typed);
    }
  });

  test('a real mobile number can never be typed into the demo', () => {
    for (const typed of ['9876500001', '+919876500001', '6000000000', '7555000019', '8555123456']) {
      assert.throws(() => demoPhone(typed), err => err instanceof Invalid && err.field === 'phone' && /demo/i.test(err.message) && /555/.test(err.message), typed);
    }
  });

  test('a live site takes Indian mobiles starting 6 to 9, in the ways people write them', () => {
    for (const typed of ['9876500001', '98765 00001', '98765-00001', '+919876500001', '+91 98765 00001', '(+91) 98765-00001', '919876500001', '09876500001']) {
      assert.equal(livePhone(typed), '+919876500001', typed);
    }
    for (const first of '6789') assert.equal(livePhone(first + '123456789'), '+91' + first + '123456789');
    assert.equal(is.phone({ demo: false })('9198765000'), '+919198765000', 'a ten digit number that happens to start 91 is not cut short');
  });

  test('a live site refuses sample numbers, landlines, foreign and malformed numbers', () => {
    const refused = [
      '5550000199', '+915550000199',             // demo samples
      '0123456789', '1234567890', '2345678901', '3456789012', '4567890123', '5123456789',
      '987650000', '98765000012',                // nine and eleven digits
      '+1 415 555 0100', '+44 7700 900123',
      '98765oooo1', 'call me', '', '          ',
      '9876500001; DROP TABLE customers',
      9876500001, null, undefined, {}, ['9876500001'], true,
    ];
    for (const v of refused) refusesValue(livePhone, v, 'phone');
  });
});

describe('validate: vehicle numbers', () => {
  test('a plate is stored one way however it is typed', () => {
    const reg = is.regNo('regNo');
    for (const typed of ['PB10HT2005', 'pb10ht2005', 'PB 10 HT 2005', 'pb-10-ht-2005', 'PB.10.HT.2005', ' pb10 ht2005 ']) assert.equal(reg(typed), 'PB10HT2005', typed);
    assert.equal(reg('22 BH 1234 AA'), '22BH1234AA', 'BH series');
    assert.equal(reg('PJB 1234'), 'PJB1234', 'an old plate');
  });

  test('a plate with symbols, markup, too few or too many characters is refused', () => {
    const reg = is.regNo('regNo');
    for (const v of ['PB1', 'PB10HT2005XYZ', 'PB10/HT/2005', 'PB10<b>2005', "PB10'OR'1", cp(0x0A2A, 0x0A70, 0x0A1C, 0x0A3E, 0x0A2C) + '1234', '', 'P'.repeat(30), 102005, null, ['PB10HT2005']]) refusesValue(reg, v, 'regNo');
  });

  test('the last four characters asked for at sign-in must be exactly four', () => {
    const tail = is.plateTail('plate');
    assert.equal(tail('2005'), '2005');
    assert.equal(tail('t2 00'), 'T200');
    assert.equal(tail('20-05'), '2005');
    for (const v of ['205', '20055', '20 0', '2*05', '', 2005, null]) refusesValue(tail, v, 'plate');
  });
});

// the q in the body of POST /api/staff/lookup: part of a vehicle number, or digits of a phone number
describe('validate: what staff type to find a customer', () => {
  test('a search is tidied to plain letters and digits, however it is typed', () => {
    const q = is.lookup('q');
    assert.equal(q('pb10'), 'PB10');
    assert.equal(q(' pb-10 ht.2005 '), 'PB10HT2005');
    assert.equal(q('2005'), '2005');
    assert.equal(q('ht2'), 'HT2', 'three characters of a plate are enough');
    assert.equal(q('98765 00001'), '9876500001');
    assert.equal(q('0001'), '0001', 'the last digits of a phone number');
    // the country code comes off a full number, because that is not how staff read a number out
    for (const typed of ['+91 98765 00001', '+919876500001', '919876500001', '91-98765-00001']) assert.equal(q(typed), '9876500001', typed);
    assert.equal(q('9198765'), '9198765', 'digits that only happen to start with 91 are left alone');
    assert.equal(q('A1B2C3D4E5F6G7'), 'A1B2C3D4E5F6G7', 'fourteen characters is the most');
  });

  test('a search that is too short, too long, or holds anything but letters and digits is refused', () => {
    const q = is.lookup('q');
    const refused = [
      'ab', '1 2', 'p-b', '', '   ', '+-.',
      'PB10%', '%%%', 'PB_10', 'PB10*', 'PB10\\', "PB10' OR '1'='1", 'PB10<b>', 'PB10;--',   // nothing that means something to a database or a page
      cp(0x0A2A, 0x0A70, 0x0A1C, 0x0A3E, 0x0A2C) + '10',
      'A'.repeat(15), 'x'.repeat(25), '9'.repeat(200),
      2005, 9876500001, null, undefined, ['PB10'], { q: 'PB10' }, true,
    ];
    for (const v of refused) {
      refusesValue(q, v, 'q');
      assert.throws(() => q(v), /at least 3 characters of the vehicle number, or 4 digits of the phone number/, util.inspect(v));
    }
  });

  test('a full phone number typed with the 0 some people dial first is searched as the number itself',
    () => {
      const q = is.lookup('q');
      for (const typed of ['09876500001', '098765 00001', '0 98765-00001']) assert.equal(q(typed), '9876500001', typed);
      // only a full number has the prefix taken off: the last digits of a number may well start with 0
      assert.equal(q('0001'), '0001');
      assert.equal(q('00001'), '00001');
    });
});

describe('validate: tyre sizes, bill numbers and names', () => {
  test('a size is tidied to the way it is on the sidewall', () => {
    const size = is.size('size');
    assert.equal(size('185/65 r15'), '185/65 R15');
    assert.equal(size('  185/65    R15 '), '185/65 R15');
    assert.equal(size('185/65\tR15'), '185/65 R15');
    assert.equal(size('3.00-18'), '3.00-18');
    assert.equal(size('10.00-20'), '10.00-20');
    assert.equal(size('295/80 r22.5'), '295/80 R22.5');
  });

  test('a size that is not a size is refused', () => {
    const size = is.size('size');
    for (const v of ['R15', 'big ones', '18', '185/65 R15 <b>', '185/65 R15; --', '185/65_R15', '185/65 R15 EXTRA LOAD XL', '1'.repeat(41), '', 18565, null, {}]) refusesValue(size, v, 'size');
  });

  test('a bill number keeps letters, digits, slash and hyphen only', () => {
    const bill = is.billNo('billNo');
    assert.equal(bill('inv/24-25/0012'), 'INV/24-25/0012');
    for (const v of ['INV#12', '<12>', '-12', 'A'.repeat(31), 12, null]) refusesValue(bill, v, 'billNo');
  });

  test('control and invisible characters are stripped from text, and spacing is collapsed', () => {
    const name = is.text('tyre', 2, 80, 'the tyre brand and model');
    assert.equal(name('  MRF   ZLX  '), 'MRF ZLX');
    assert.equal(name('MRF\u0000ZLX\u0007'), 'MRF ZLX');
    assert.equal(name('MRF\nZLX\r\n\tTubeless'), 'MRF ZLX Tubeless', 'no line breaks reach a message or a page');
    assert.equal(name(cp(0xFF2D, 0xFF32, 0xFF26) + ' ZLX'), 'MRF ZLX', 'full-width letters are folded to plain ones');
    const dirty = name('Apollo' + cp(0x1b) + '[31m ' + cp(0x202e) + 'Alnac' + cp(0x200b) + ' 4G' + cp(0xfeff, 0x85, 0x7f));
    assert.deepEqual([...dirty].filter(hidden), [], 'nothing invisible is left');
    assert.match(dirty, /^Apollo.*Alnac.*4G$/);
  });

  test('text with angle brackets, of the wrong length or of the wrong type is refused', () => {
    const name = is.text('tyre', 2, 80, 'the tyre brand and model');
    const refused = [
      '<script>alert(1)</script>', 'MRF <b>ZLX</b>', 'MRF > CEAT',
      'MRF ' + cp(0xFF1C) + 'script' + cp(0xFF1E),   // full-width brackets that fold into real ones
      'M', ' M ', cp(0, 0, 0), cp(0x200b, 0x200b, 0x200b, 0x200b),
      'x'.repeat(81), 'x'.repeat(5000),
      42, null, undefined, ['MRF ZLX'], { toString: () => 'MRF ZLX' },
    ];
    for (const v of refused) refusesValue(name, v, 'tyre');
  });
});

describe('validate: money, numbers and dates', () => {
  test('rupees come in and whole paise go out', () => {
    const rupees = is.rupees('amount');
    assert.equal(rupees(21400), 2140000);
    assert.equal(rupees(0), 0);
    assert.equal(rupees(1234.56), 123456);
    assert.equal(rupees(19.99), 1999);
    assert.equal(rupees(0.1 + 0.2), 30);
    assert.equal(rupees(1e7), 1e9);
    // every amount with two decimals lands on exactly the right paise
    for (let paise = 0; paise <= 2500000; paise += 7) {
      const got = rupees(paise / 100);
      if (got !== paise) assert.fail(`${paise / 100} rupees became ${got} paise`);
    }
    for (const paise of [999999999, 123456789, 100000001, 314159265]) assert.equal(rupees(paise / 100), paise);
  });

  test('an amount that is negative, absurd, or not a number is refused', () => {
    const rupees = is.rupees('amount');
    for (const v of [-1, -0.01, 1e7 + 1, NaN, Infinity, -Infinity, '21400', '21,400', '', null, [21400], { rupees: 21400 }, true]) refusesValue(rupees, v, 'amount');
  });

  test('whole numbers must be whole, in range, and real numbers', () => {
    const qty = is.int('qty', 1, 24, 'the number of tyres');
    assert.equal(qty(1), 1);
    assert.equal(qty(24), 24);
    for (const v of [0, 25, -4, 2.5, NaN, Infinity, '4', null, [4], true]) refusesValue(qty, v, 'qty');
    const odo = is.int('odometerKm', 0, 3000000, 'the odometer reading in km');
    assert.equal(odo(0), 0);
    for (const v of [-1, 3000001, 1e21, '48200']) refusesValue(odo, v, 'odometerKm');
  });

  test('a tread reading is kept to one decimal place and must be in range', () => {
    const mm = is.mm('treadMm', 0, 30, 'the tread depth');
    assert.equal(mm(3.14159), 3.1);
    assert.equal(mm(6.96), 7);
    assert.equal(mm(0), 0);
    assert.equal(mm(1.6), 1.6);
    for (const v of [-0.1, 30.1, NaN, Infinity, '5.6', null, [5.6]]) refusesValue(mm, v, 'treadMm');
  });

  test('a date must be a real calendar day', () => {
    assert.equal(validDay('2026-10-06'), true);
    assert.equal(validDay('2024-02-29'), true, 'a leap day');
    for (const v of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '06-10-2026', '2026-10-6', '2026/10/06', '2026-10-06T10:00:00Z', '', 20261006, null, undefined]) {
      assert.equal(validDay(v), false, util.inspect(v));
    }
  });

  test('a fitting or visit date cannot be in the future or further back than allowed', () => {
    const day = is.day('visitedOn', '2026-10-06', 7, 'the visit date');
    assert.equal(day('2026-10-06'), '2026-10-06', 'today');
    assert.equal(day('2026-09-29'), '2026-09-29', 'seven days back is the limit');
    assert.throws(() => day('2026-09-28'), err => err instanceof Invalid && err.field === 'visitedOn' && /too far back/.test(err.message));
    assert.throws(() => day('2026-10-07'), err => err instanceof Invalid && err.field === 'visitedOn' && /future/.test(err.message));
    assert.throws(() => day('2027-01-01'), err => err instanceof Invalid && /future/.test(err.message));
    for (const v of ['2026-02-30', 'yesterday', '06/10/2026', 20261006, null, new Date(0)]) refusesValue(day, v, 'visitedOn');
    // the window follows the calendar across a month and a leap day
    assert.equal(is.day('fittedOn', '2024-03-01', 1, 'the fitting date')('2024-02-29'), '2024-02-29');
    refusesValue(is.day('fittedOn', '2024-03-01', 1, 'the fitting date'), '2024-02-28', 'fittedOn');
  });
});

describe('validate: codes, choices and locations', () => {
  test('a sign-in code is six digits and a PIN is digits only', () => {
    assert.equal(is.code('123456'), '123456');
    assert.equal(is.code(' 123456 '), '123456');
    for (const v of ['12345', '1234567', '12 3456', 'abcdef', '', 123456, null, ['123456']]) refusesValue(is.code, v, 'code');
    assert.equal(is.pin('48151623'), '48151623');
    for (const v of ['123', '1'.repeat(13), '4815a623', "' OR 1=1 --", '', 48151623, null, ['48151623']]) refusesValue(is.pin, v, 'pin');
  });

  test('a referral code is eight letters and digits, however it is typed', () => {
    const ref = is.referralCode('ref');
    assert.equal(ref('abcd-2345'), 'ABCD2345');
    assert.equal(ref('ABCD 2345'), 'ABCD2345');
    for (const v of ['ABC2345', 'ABCD23456', 'ABCD_234', 'ABCD234!', '', 12345678, null]) refusesValue(ref, v, 'ref');
  });

  test('links and request labels take only safe characters', () => {
    const token = is.token('sale'), idem = is.idem('idem');
    assert.equal(token('AbCdEfGh_-012345'), 'AbCdEfGh_-012345');
    for (const v of ['short', 'AbCdEfGh/+012345', '../../etc/passwd....', 'x'.repeat(65), 1234567890123456, null]) refusesValue(token, v, 'sale');
    assert.equal(idem('sale-0001'), 'sale-0001');
    for (const v of ['short', 'has space 1', 'x'.repeat(41), 12345678, null]) refusesValue(idem, v, 'idem');
  });

  test('a choice must be one that is offered, and a list of services only listed ones', () => {
    const confirm = is.oneOf('confirm', ['DELETE']);
    assert.equal(confirm('DELETE'), 'DELETE');
    for (const v of ['delete', 'DELETE ', 'yes', true, null, ['DELETE']]) refusesValue(confirm, v, 'confirm');

    const known = new Map([['rotation', 'Tyre rotation'], ['alignment-check', 'Alignment check']]);
    const keys = is.keys('services', known, 3);
    assert.deepEqual(keys(['rotation', 'alignment-check']), ['rotation', 'alignment-check']);
    assert.deepEqual(keys(['rotation', 'rotation']), ['rotation'], 'the same service twice is one service');
    assert.deepEqual(keys([]), []);
    for (const v of [['free-tyres'], ['rotation', 7], 'rotation', { 0: 'rotation' }, ['rotation', 'rotation', 'rotation', 'rotation'], null]) refusesValue(keys, v, 'services');
  });

  test('yes or no must be a real yes or no', () => {
    const ok = is.bool('remindersOk');
    assert.equal(ok(true), true);
    assert.equal(ok(false), false);
    for (const v of ['true', 'yes', 1, 0, null, []]) refusesValue(ok, v, 'remindersOk');
  });

  test('a breakdown location is kept to about a metre and must be on the globe', () => {
    const lat = is.coord('lat', 90), lng = is.coord('lng', 180);
    assert.equal(lat(30.912234567), 30.91223);
    assert.equal(lng(-75.848399999), -75.8484);
    assert.equal(lat(0), 0);
    assert.equal(lng(180), 180);
    for (const v of [90.5, -91, NaN, Infinity, '30.9', null, [30.9]]) refusesValue(lat, v, 'lat');
    for (const v of [180.5, -181, '75.8']) refusesValue(lng, v, 'lng');
    const acc = is.metres('accuracyM');
    assert.equal(acc(35.4), 35);
    for (const v of [-1, 2e6, NaN, '35', null]) refusesValue(acc, v, 'accuracyM');
  });
});

describe('validate: the shape of a request', () => {
  const spec = () => ({
    phone: need(is.phone(), 'Enter your mobile number.'),
    odometerKm: need(is.int('odometerKm', 0, 3000000, 'the odometer reading in km'), 'Enter the odometer reading.'),
    amount: opt(is.rupees('amount')),
    remindersOk: opt(is.bool('remindersOk')),
  });
  const good = () => ({ phone: '98765 00001', odometerKm: 48200, amount: 31200, remindersOk: true });

  test('a good request comes back cleaned, with missing optional parts as null', () => {
    assert.deepEqual(shape(good(), spec()), { phone: '+919876500001', odometerKm: 48200, amount: 3120000, remindersOk: true });
    assert.deepEqual(shape({ phone: '9876500001', odometerKm: 0 }, spec()), { phone: '+919876500001', odometerKm: 0, amount: null, remindersOk: null });
    assert.deepEqual(shape({ phone: '9876500001', odometerKm: 0, amount: '', remindersOk: null }, spec()), { phone: '+919876500001', odometerKm: 0, amount: null, remindersOk: null });
  });

  test('zero and "no" are answers, not blanks', () => {
    const out = shape({ phone: '9876500001', odometerKm: 0, amount: 0, remindersOk: false }, spec());
    assert.equal(out.odometerKm, 0);
    assert.equal(out.amount, 0);
    assert.equal(out.remindersOk, false);
  });

  test('a field the server did not ask for is refused, so a phone cannot slip in an identity or an amount', () => {
    for (const extra of ['customerId', 'amountPaise', 'staff', 'isStaff', 'role', 'earned', 'used_at', 'Phone', 'phone ']) {
      assert.throws(() => shape({ ...good(), [extra]: 1 }, spec()), err => err instanceof Invalid && err.field === extra && /not expected/.test(err.message), extra);
    }
  });

  test('names built into every object are refused like any other unknown field', () => {
    for (const text of ['{"__proto__":{"staff":true}}', '{"constructor":1}', '{"toString":"x"}', '{"hasOwnProperty":1}', '{"valueOf":1}']) {
      const body = { ...good() };
      const extra = JSON.parse(text);
      const [k] = Object.keys(extra);
      Object.defineProperty(body, k, { value: extra[k], enumerable: true, configurable: true, writable: true });
      assert.throws(() => shape(body, spec()), err => err instanceof Invalid && err.field === k && /not expected/.test(err.message), text);
    }
    assert.equal({}.staff, undefined, 'nothing leaked onto every object');
  });

  test('a long unknown field name is not echoed back in full', () => {
    assert.throws(() => shape({ ...good(), ['x'.repeat(5000)]: 1 }, spec()), err => err instanceof Invalid && err.field.length <= 40);
  });

  test('a needed field that is missing or blank is refused with its own message', () => {
    for (const blank of [undefined, null, '']) {
      assert.throws(() => shape({ ...good(), phone: blank }, spec()), err => err instanceof Invalid && err.field === 'phone' && err.message === 'Enter your mobile number.', util.inspect(blank));
    }
    assert.throws(() => shape({ phone: '9876500001' }, spec()), err => err instanceof Invalid && err.field === 'odometerKm' && err.message === 'Enter the odometer reading.');
  });

  test('a value of the wrong kind is refused by its own checker', () => {
    assert.throws(() => shape({ ...good(), amount: '31200' }, spec()), err => err instanceof Invalid && err.field === 'amount');
    assert.throws(() => shape({ ...good(), odometerKm: '48200' }, spec()), err => err instanceof Invalid && err.field === 'odometerKm');
    assert.throws(() => shape({ ...good(), phone: { $ne: '' } }, spec()), err => err instanceof Invalid && err.field === 'phone');
    assert.throws(() => shape({ ...good(), remindersOk: 'true' }, spec()), err => err instanceof Invalid && err.field === 'remindersOk');
  });

  test('anything that is not one JSON object is refused', () => {
    for (const body of [null, undefined, 'phone=9876500001', 42, true, [], [good()]]) {
      assert.throws(() => shape(body, spec()), Invalid, util.inspect(body));
    }
  });

  test('an empty spec accepts only an empty object', () => {
    assert.deepEqual(shape({}, {}), {});
    assert.throws(() => shape({ anything: 1 }, {}), Invalid);
  });
});

/* =====================================================================================================
   server/throttle.js
   ===================================================================================================== */

describe('throttle: counters and lock-outs', () => {
  const memDb = t => { const db = openDb({ mode: 'demo' }, 0); t.after(() => db.close()); return db; };
  const row = (db, key) => db.q('SELECT count, window_start, locked_until, strikes FROM throttle WHERE key = ?').get(key);
  const PIN = { tries: 3, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 4 * HOUR };
  // three wrong tries at the same moment; returns what the third one said
  const lockOut = (db, key, lock, at) => { let last; for (let i = 0; i < lock.tries; i++) last = throttle.strike(db, key, lock, at); return last; };

  test('requests are allowed up to the limit, then refused with the time left to wait', t => {
    const db = memDb(t);
    const rules = [{ key: 'api:ip:a', limit: 3, windowMs: MIN }];
    for (const at of [0, 1000, 2000]) assert.deepEqual(throttle.allow(db, rules, at), { ok: true, retryAfterMs: 0 });
    assert.deepEqual(throttle.allow(db, rules, 3000), { ok: false, retryAfterMs: 57000 });
    assert.deepEqual(throttle.allow(db, rules, 59999), { ok: false, retryAfterMs: 1 });
    // a new minute is a new allowance, and it runs out the same way
    for (const at of [60000, 60001, 60002]) assert.equal(throttle.allow(db, rules, at).ok, true);
    assert.deepEqual(throttle.allow(db, rules, 60003), { ok: false, retryAfterMs: 59997 });
  });

  test('one address running out does not touch another', t => {
    const db = memDb(t);
    const a = [{ key: 'api:ip:a', limit: 1, windowMs: MIN }], b = [{ key: 'api:ip:b', limit: 1, windowMs: MIN }];
    assert.equal(throttle.allow(db, a, 0).ok, true);
    assert.equal(throttle.allow(db, a, 1).ok, false);
    assert.equal(throttle.allow(db, b, 2).ok, true);
  });

  test('a refused request costs nothing: every rule is counted only when all of them pass', t => {
    const db = memDb(t);
    // one code a minute, three in fifteen minutes
    const rules = [{ key: 'otp:gap', limit: 1, windowMs: MIN }, { key: 'otp:p', limit: 3, windowMs: 15 * MIN }];
    assert.equal(throttle.allow(db, rules, 0).ok, true);
    for (let at = 1000; at <= 10000; at += 1000) assert.deepEqual(throttle.allow(db, rules, at), { ok: false, retryAfterMs: MIN - at });
    assert.equal(row(db, 'otp:p').count, 1, 'ten impatient taps did not use up the fifteen minute allowance');
    assert.equal(row(db, 'otp:gap').count, 1);

    assert.equal(throttle.allow(db, rules, 60000).ok, true);
    assert.equal(throttle.allow(db, rules, 120000).ok, true);
    // the third code was the last: the wait is the longer of the two rules
    assert.deepEqual(throttle.allow(db, rules, 121000), { ok: false, retryAfterMs: 15 * MIN - 121000 });
    assert.deepEqual(throttle.allow(db, rules, 180000), { ok: false, retryAfterMs: 15 * MIN - 180000 });
    assert.equal(row(db, 'otp:p').count, 3);
    assert.equal(row(db, 'otp:gap').count, 1, 'the per-minute counter was not charged for a request the other rule refused');
    assert.equal(throttle.allow(db, rules, 15 * MIN).ok, true);
  });

  test('a refund hands back an allowance that was counted for something that did not happen', t => {
    const db = memDb(t);
    const rules = [{ key: 'otp:gap', limit: 1, windowMs: MIN }, { key: 'otp:p', limit: 3, windowMs: 15 * MIN }];
    assert.equal(throttle.allow(db, rules, 0).ok, true);
    throttle.refund(db, rules);                                    // the SMS provider refused: no code went out
    assert.equal(throttle.allow(db, rules, 1).ok, true, 'the customer can try again straight away');
    assert.equal(row(db, 'otp:p').count, 1, 'and only one code is counted');
    assert.equal(throttle.allow(db, rules, 2).ok, false, 'the limit itself still stands');
  });

  test('a refund never takes a counter below zero or makes up an allowance', t => {
    const db = memDb(t);
    const rules = [{ key: 'otp:gap', limit: 1, windowMs: MIN }];
    throttle.refund(db, rules);                                    // nothing counted yet
    assert.equal(row(db, 'otp:gap'), undefined);
    assert.equal(throttle.allow(db, rules, 0).ok, true);
    throttle.refund(db, rules);
    throttle.refund(db, rules);
    throttle.refund(db, rules);
    assert.equal(row(db, 'otp:gap').count, 0);
    assert.equal(throttle.allow(db, rules, 1).ok, true);
    assert.equal(throttle.allow(db, rules, 2).ok, false, 'three refunds for one request bought one retry, not three');
  });

  test('wrong tries count down, then lock for the set time', t => {
    const db = memDb(t);
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 0), 0, 'nothing is locked to begin with');
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 0), { lockedMs: 0, left: 2 });
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 1000), { lockedMs: 0, left: 1 });
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 1500), 0);
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 2000), { lockedMs: 15 * MIN, left: 0 });
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 2000), 15 * MIN);
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 2000 + 15 * MIN - 1), 1);
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 2000 + 15 * MIN), 0, 'the lock ends on time');
    assert.equal(throttle.lockedFor(db, 'pin:ip:b', 2000), 0, 'another address is not locked');
  });

  test('each further lock-out lasts twice as long, up to the cap', t => {
    const db = memDb(t);
    const got = [];
    let at = 0;
    for (let round = 0; round < 7; round++) {
      const hit = lockOut(db, 'pin:ip:a', PIN, at);
      got.push(hit.lockedMs / MIN);
      at += hit.lockedMs;                                           // come back the moment the lock ends
      assert.equal(throttle.lockedFor(db, 'pin:ip:a', at), 0);
    }
    assert.deepEqual(got, [15, 30, 60, 120, 240, 240, 240]);
  });

  test('a lock-out with no room to grow stays the same length', t => {
    const db = memDb(t);
    const DEVICE = { tries: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 15 * MIN };
    let at = 0;
    for (let round = 0; round < 3; round++) {
      const hit = lockOut(db, 'pin:dev:a', DEVICE, at);
      assert.equal(hit.lockedMs, 15 * MIN);
      at += hit.lockedMs;
    }
  });

  test('wrong tries spread wider than the window do not add up to a lock', t => {
    const db = memDb(t);
    assert.equal(throttle.strike(db, 'pin:ip:a', PIN, 0).left, 2);
    assert.equal(throttle.strike(db, 'pin:ip:a', PIN, 14 * MIN).left, 1);
    // the window opened at the first wrong try has closed; counting starts again
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 15 * MIN), { lockedMs: 0, left: 2 });
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 16 * MIN), { lockedMs: 0, left: 1 });
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 16 * MIN), 0);
  });

  test('a correct entry clears the count and the doubling', t => {
    const db = memDb(t);
    let at = 0;
    at += lockOut(db, 'pin:ip:a', PIN, at).lockedMs;
    at += lockOut(db, 'pin:ip:a', PIN, at).lockedMs;                // second lock-out: 30 minutes
    throttle.strike(db, 'pin:ip:a', PIN, at);
    throttle.strike(db, 'pin:ip:a', PIN, at);                       // two wrong, then the right PIN
    throttle.clear(db, 'pin:ip:a');
    assert.equal(row(db, 'pin:ip:a'), undefined);
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, at), { lockedMs: 0, left: 2 }, 'a full set of tries again');
    assert.equal(lockOut(db, 'pin:ip:b', PIN, at).lockedMs, 15 * MIN);
    throttle.strike(db, 'pin:ip:a', PIN, at);
    assert.equal(throttle.strike(db, 'pin:ip:a', PIN, at).lockedMs, 15 * MIN, 'and the next lock-out is the short one');
    throttle.clear(db, 'pin:never-seen');                           // clearing nothing is harmless
  });

  test('a lock-out and a used-up allowance survive a restart', () => {
    const cfg = { mode: 'live', dataDir: tmpPath('throttle-db') };
    const rules = [{ key: 'otp:p', limit: 2, windowMs: HOUR }];
    let db = openDb(cfg, 0);
    try {
      lockOut(db, 'pin:ip:a', PIN, 1000);
      throttle.allow(db, rules, 1000);
      throttle.allow(db, rules, 2000);
    } finally { db.close(); }

    db = openDb(cfg, 5000);
    try {
      assert.equal(throttle.lockedFor(db, 'pin:ip:a', 5000), 15 * MIN - 4000);
      assert.deepEqual(throttle.allow(db, rules, 5000), { ok: false, retryAfterMs: HOUR - 4000 });
      // the doubling is remembered too
      assert.equal(lockOut(db, 'pin:ip:a', PIN, 1000 + 15 * MIN).lockedMs, 30 * MIN);
    } finally { db.close(); }
  });

  test('a wrong try made during a lock-out changes nothing and is told how long is left', t => {
    const db = memDb(t);
    assert.equal(lockOut(db, 'pin:ip:a', PIN, 0).lockedMs, 15 * MIN);
    const asLocked = { ...row(db, 'pin:ip:a') };
    assert.deepEqual(asLocked, { count: 0, window_start: 0, locked_until: 15 * MIN, strikes: 1 });

    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 1000), { lockedMs: 15 * MIN - 1000, left: 0 });
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 1001), 15 * MIN - 1001, 'still locked one second later, for exactly as long as before');
    // hammering on the locked key, right up to its last millisecond
    for (let at = 2000; at < 15 * MIN; at += 20e3) assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, at), { lockedMs: 15 * MIN - at, left: 0 });
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 15 * MIN - 1), { lockedMs: 1, left: 0 });
    assert.deepEqual({ ...row(db, 'pin:ip:a') }, asLocked, 'the row is exactly as the lock-out left it: not lifted, not lengthened, nothing counted');
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 15 * MIN - 1), 1);
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', 15 * MIN), 0, 'and the lock ends when it was always going to');

    // the tries made while locked were not saved up: a full set afterwards, and the next lock-out is only the second
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 15 * MIN), { lockedMs: 0, left: 2 });
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 15 * MIN + 1), { lockedMs: 0, left: 1 });
    assert.deepEqual(throttle.strike(db, 'pin:ip:a', PIN, 15 * MIN + 2), { lockedMs: 30 * MIN, left: 0 });
  });

  test('a count kept over a whole day catches wrong tries that are too far apart for the short counter', t => {
    const db = memDb(t);
    // the shape of the staff PIN rules: 5 tries in 15 minutes for an address, 60 wrong tries in 24 hours for the day
    const SHORT = { tries: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 4 * HOUR };
    const DAY = { tries: 60, windowMs: 24 * HOUR, lockMs: 12 * HOUR, maxLockMs: 24 * HOUR };
    let at = 0;
    for (let n = 1; n <= 59; n++, at += 20 * MIN) {                 // one wrong PIN every twenty minutes
      assert.deepEqual(throttle.strike(db, 'pin:ip:a', SHORT, at), { lockedMs: 0, left: 4 }, `try ${n}: the short counter starts again every time`);
      assert.deepEqual(throttle.strike(db, 'pin:day', DAY, at), { lockedMs: 0, left: 60 - n }, `try ${n}`);
    }
    assert.equal(at, 19 * HOUR + 40 * MIN);
    assert.deepEqual(throttle.strike(db, 'pin:day', DAY, at), { lockedMs: 12 * HOUR, left: 0 }, 'the sixtieth wrong try inside a day locks for twelve hours');
    assert.equal(throttle.lockedFor(db, 'pin:ip:a', at), 0, 'the address itself never got locked');
    // going on guessing through the lock neither lifts it nor makes it longer
    for (let h = 1; h < 12; h++) assert.deepEqual(throttle.strike(db, 'pin:day', DAY, at + h * HOUR), { lockedMs: (12 - h) * HOUR, left: 0 });
    assert.equal(throttle.lockedFor(db, 'pin:day', at + 12 * HOUR - 1), 1);
    assert.equal(throttle.lockedFor(db, 'pin:day', at + 12 * HOUR), 0);
    // sixty more after that: twenty-four hours, and that is the cap
    at += 12 * HOUR;
    assert.equal(lockOut(db, 'pin:day', DAY, at).lockedMs, 24 * HOUR);
    at += 24 * HOUR;
    assert.equal(lockOut(db, 'pin:day', DAY, at).lockedMs, 24 * HOUR);
    // fifty-nine in a day is under the count: the sixtieth, a day after the first, opens a new day
    const slow = 'pin:day:slow';
    for (let n = 1; n <= 59; n++) assert.equal(throttle.strike(db, slow, DAY, n * MIN).lockedMs, 0);
    assert.deepEqual(throttle.strike(db, slow, DAY, MIN + 24 * HOUR), { lockedMs: 0, left: 59 });
  });

  test('a look at a counter says how long it is full for, without counting anything', t => {
    const db = memDb(t);
    // the shape of the hourly SMS spending cap
    const cap = { key: 'otp:all', limit: 2, windowMs: HOUR };
    assert.equal(throttle.waitFor(db, cap, 0), 0, 'never used: there is room');
    assert.equal(row(db, 'otp:all'), undefined, 'and looking did not start the hour');

    assert.equal(throttle.allow(db, [cap], 1000).ok, true);
    for (let i = 0; i < 50; i++) assert.equal(throttle.waitFor(db, cap, 2000), 0, 'one of two used: there is room');
    assert.deepEqual({ ...row(db, 'otp:all') }, { count: 1, window_start: 1000, locked_until: 0, strikes: 0 }, 'fifty looks counted nothing');

    assert.equal(throttle.allow(db, [cap], 3000).ok, true);
    assert.equal(throttle.waitFor(db, cap, 4000), HOUR - 3000, 'full: the wait runs to the end of the hour the first one opened');
    assert.deepEqual(throttle.allow(db, [cap], 4000), { ok: false, retryAfterMs: HOUR - 3000 }, 'the same answer a real request would get');
    assert.equal(throttle.waitFor(db, cap, 1000 + HOUR - 1), 1);
    assert.equal(throttle.waitFor(db, cap, 1000 + HOUR), 0, 'a new hour has room again');
    assert.equal(throttle.waitFor(db, cap, 1000 + HOUR + 5 * MIN), 0, 'and the wait never runs backwards once the hour is over');
    assert.equal(row(db, 'otp:all').count, 2);

    // a refund is seen by the next look
    throttle.refund(db, [cap]);
    assert.equal(throttle.waitFor(db, cap, 5000), 0);
    assert.equal(throttle.waitFor(db, { key: 'otp:all', limit: 1, windowMs: HOUR }, 5000), HOUR - 4000, 'a tighter limit on the same counter is still full');
  });
});

/* =====================================================================================================
   server/estimate.js
   ===================================================================================================== */

/* Fixed numbers for the arithmetic tests (the same as the shipped car and two-wheeler profiles on the day
   these tests were written), so an owner editing config/passport.json does not change what is asserted here.
   Car: 5.5 mm of usable tread over 45,000 km at 1,000 km a month, so 45 months when nothing is known. */
const TYRES = {
  maxAgeYears: 6,
  minKmForReadings: 5000,
  profiles: [
    { key: 'two-wheeler', sizeMatch: '^[2-4]\\.\\d{2}-\\d{2}$|^\\d{2,3}/\\d{2,3}-\\d{2}$', newTreadMm: 5, replaceAtMm: 1, legalMinMm: 0.8, typicalLifeKm: 30000, typicalMonthlyKm: 800 },
    { key: 'car', sizeMatch: '', newTreadMm: 7.5, replaceAtMm: 2, legalMinMm: 1.6, typicalLifeKm: 45000, typicalMonthlyKm: 1000 },
  ],
};
const FIT = '2026-01-01';
const FIT_KM = 20000;
const carSale = (over = {}) => ({ fitted_on: FIT, odometer_km: FIT_KM, size: '185/65 R15', new_tread_mm: null, ...over });
const purchase = { kind: 'purchase', visited_on: FIT, odometer_km: FIT_KM, tread_mm: null, services: [] };
// a later visit: `days` after fitting, `km` driven since fitting (or no odometer reading), tread in mm (or none)
const visit = (days, km, tread, over = {}) => ({ kind: 'service', visited_on: est.addDays(FIT, days), odometer_km: km == null ? null : FIT_KM + km, tread_mm: tread == null ? null : tread, services: [], ...over });
const day = n => est.addDays(FIT, n);
const estimate = (visits, today, sale = carSale()) => est.estimateSale(sale, [purchase, ...visits], TYRES, today);

describe('estimate: when the tyres will need replacing', () => {
  test('with no readings the estimate rests on typical life and typical monthly distance', () => {
    const e = estimate([], '2026-07-01');                            // 181 days after fitting
    assert.equal(e.basis, 'typical');
    assert.equal(e.reason, 'wear');
    assert.equal(e.profile, 'car');
    assert.equal(e.kmPerMonth, 1000);
    assert.equal(e.kmPerMonthMeasured, false);
    assert.equal(e.dueOn, '2029-10-02', '45 months after fitting');
    assert.equal(e.daysLeft, 1189);
    assert.equal(e.kmLeft, 39100);
    assert.equal(e.treadNowMm, 6.8, 'about six months of typical wear off 7.5 mm');
    assert.equal(e.readings, 1, 'fitting day is the only reading');
    assert.equal(e.lastReadingOn, null);
    assert.equal(e.lastReadingMm, null);
    assert.equal(e.atLimit, false);
  });

  test('on fitting day the tyre is new, and a tread depth measured at fitting replaces the typical one', () => {
    assert.equal(estimate([], FIT).treadNowMm, 7.5);
    const measured = estimate([], FIT, carSale({ new_tread_mm: 8.2 }));
    assert.equal(measured.newTreadMm, 8.2);
    assert.equal(measured.treadNowMm, 8.2);
  });

  test('the customer\'s own monthly distance is used as soon as the odometer shows it', () => {
    // 6,000 km in the first 90 days: twice the typical distance
    const e = estimate([visit(90, 6000, null)], day(90));
    assert.equal(e.basis, 'typical', 'no tread reading yet');
    assert.equal(e.kmPerMonthMeasured, true);
    assert.equal(e.kmPerMonth, 2030);
    assert.equal(e.dueOn, '2027-11-07', '39,000 km to go at 6,000 km per 90 days is 585 days from the reading');
    assert.equal(e.daysLeft, 585);
    assert.equal(e.kmLeft, 39000);
    assert.equal(e.treadNowMm, 6.8);
    assert.ok(e.dueOn < estimate([], day(90)).dueOn, 'sooner than the typical estimate');
  });

  test('the latest odometer reading sets the monthly distance', () => {
    const e = estimate([visit(90, 6000, null), visit(180, 6900, null)], day(180));
    assert.equal(e.kmPerMonth, 1170, '6,900 km in 180 days');
  });

  test('an odometer reading in the first two weeks is too early to measure from', () => {
    const early = estimate([visit(10, 3000, null)], day(10));
    assert.equal(early.kmPerMonthMeasured, false);
    assert.equal(early.kmPerMonth, 1000);
    assert.equal(early.dueOn, '2029-10-02');
    const twoWeeks = estimate([visit(14, 700, null)], day(14));
    assert.equal(twoWeeks.kmPerMonthMeasured, true);
    assert.equal(twoWeeks.kmPerMonth, 1520);
  });

  test('a mistyped odometer cannot give an absurd monthly distance', () => {
    assert.equal(estimate([visit(30, 100000, null)], day(30)).kmPerMonth, 30000);
    assert.equal(estimate([visit(300, 10, null)], day(300)).kmPerMonth, 50);
  });

  test('visits that cannot be readings for these tyres are ignored', () => {
    const base = estimate([], day(200));
    const noise = [
      { ...purchase, tread_mm: 3.0 },                                              // the purchase row itself
      visit(-30, 500, 2.5),                                                        // before these tyres were fitted
      { ...visit(100, null, 3.0), odometer_km: FIT_KM - 4000 },                    // odometer lower than at fitting
      visit(120, null, null, { services: ['rotation'] }),                          // a service with no reading
    ];
    assert.deepEqual(estimate(noise, day(200)), base);
  });

  test('a tread reading before 5,000 km is shown but the estimate stays on typical wear', () => {
    const e = estimate([visit(90, 4000, 6.9)], day(90));
    assert.equal(e.basis, 'typical');
    assert.equal(e.readings, 1);
    assert.equal(e.lastReadingMm, 6.9);
    assert.equal(e.lastReadingOn, '2026-04-01');
    assert.equal(e.kmPerMonthMeasured, true);
    assert.equal(e.atLimit, false);
    // typical wear over 4,000 km would leave 7.0 mm; the gauge found 6.9, and the tyre cannot have more than that.
    // 4.9 mm to the 2 mm mark at typical wear is 40,091 km: 902 days at 4,000 km per 90 days
    assert.equal(e.treadNowMm, 6.9);
    assert.equal(e.daysLeft, 902);
    assert.equal(e.kmLeft, 40100);
    assert.ok(e.dueOn < estimate([visit(90, 4000, null)], day(90)).dueOn, 'sooner than with the odometer reading alone');
  });

  test('a reading taken too early to show a wear rate still counts for what it measured', () => {
    // 3,000 km in the first 90 days and no tread reading: 42,000 km of typical life left, 1,260 days at this pace
    const blind = estimate([visit(90, 3000, null)], day(90));
    assert.equal(blind.dueOn, day(1350));
    assert.equal(blind.treadNowMm, 7.1);

    // the gauge finds 5.5 mm where typical wear would have left 7.1. Too early to work out a wear rate from, so
    // the basis stays typical, but 3.5 mm to the 2 mm mark at typical wear is 28,636 km: 859 days, not 1,260
    const e = estimate([visit(90, 3000, 5.5)], day(90));
    assert.equal(e.basis, 'typical');
    assert.equal(e.reason, 'wear');
    assert.equal(e.readings, 1);
    assert.equal(e.treadNowMm, 5.5, 'tread now is what was measured, not what a typical tyre would have');
    assert.equal(e.daysLeft, 859);
    assert.equal(e.dueOn, day(949));
    assert.equal(e.kmLeft, 28600);
    assert.equal(e.atLimit, false);
    // ninety days and 3,000 km on with nothing new, typical wear is taken off the measured depth, not off a new tyre
    const later = estimate([visit(90, 3000, 5.5)], day(180));
    assert.equal(later.dueOn, e.dueOn);
    assert.equal(later.treadNowMm, 5.1);
    assert.equal(estimate([visit(90, 3000, null)], day(180)).treadNowMm, 6.8, 'against 6.8 mm had nobody measured');

    // the same with no odometer: 6.0 mm after 60 days. 4 mm at typical wear is 32,727 km, 996 days at 1,000 km a month
    const noOdo = estimate([visit(60, null, 6.0)], day(60));
    assert.equal(noOdo.basis, 'typical');
    assert.equal(noOdo.kmPerMonthMeasured, false);
    assert.equal(noOdo.treadNowMm, 6);
    assert.equal(noOdo.daysLeft, 996);
    assert.equal(noOdo.dueOn, day(1056));
    assert.equal(estimate([], day(60)).dueOn, '2029-10-02', 'against 45 months had nobody measured');

    // an early reading can only bring the date forward: one that shows more tread than typical wear leaves is no promise
    for (const mm of [7.2, 7.4, 7.5, 7.6]) {
      const high = estimate([visit(90, 3000, mm)], day(90));
      assert.equal(high.dueOn, blind.dueOn, `${mm} mm`);
      assert.equal(high.treadNowMm, 7.1, `${mm} mm`);
      assert.equal(high.lastReadingMm, mm);
      assert.equal(high.basis, 'typical');
    }
  });

  test('two readings entered for the same day count in the order they were entered', () => {
    // staff typed 1.5 mm, saw the slip, and entered 2.4 mm straight after: the later row is the reading that stands
    const slip = visit(400, 30000, 1.5, { id: 41 }), fixed = visit(400, 30000, 2.4, { id: 42 });
    const e = estimate([slip, fixed], day(400));
    assert.equal(e.lastReadingMm, 2.4);
    assert.equal(e.treadNowMm, 2.4);
    assert.equal(e.atLimit, false);
    assert.ok(e.daysLeft > 0, `${e.daysLeft} days`);
    assert.deepEqual(estimate([fixed, slip], day(400)), e, 'whatever order the rows are handed over in');
    // entered the other way round, the low reading stands
    const worn = estimate([visit(400, 30000, 1.5, { id: 42 }), visit(400, 30000, 2.4, { id: 41 })], day(400));
    assert.equal(worn.lastReadingMm, 1.5);
    assert.equal(worn.atLimit, true);
    assert.equal(worn.dueOn, day(400));
    // the same for a corrected odometer: 60,000 km mistyped, 6,000 km entered after it
    const odo = [visit(90, 60000, null, { id: 7 }), visit(90, 6000, null, { id: 8 })];
    assert.equal(estimate(odo, day(90)).kmPerMonth, 2030);
    assert.equal(estimate([odo[1], odo[0]], day(90)).kmPerMonth, 2030);
    assert.equal(estimate([visit(90, 60000, null, { id: 8 }), visit(90, 6000, null, { id: 7 })], day(90)).kmPerMonth, 20290);
    // the day still comes first: an older visit typed in late, with a higher row id, does not become the latest reading
    const late = estimate([visit(400, 30000, 2.4, { id: 5 }), visit(390, 29000, 1.5, { id: 9 })], day(400));
    assert.equal(late.lastReadingMm, 2.4);
    assert.equal(late.lastReadingOn, day(400));
    assert.equal(late.atLimit, false);
  });

  test('from 5,000 km a tread reading moves the estimate onto measured wear', () => {
    // 1 mm gone in 5,000 km over 90 days. 4.5 mm left to the 2 mm mark is 22,500 km, 405 days at this pace
    const e = estimate([visit(90, 5000, 6.5)], day(90));
    assert.equal(e.basis, 'readings');
    assert.equal(e.readings, 2);
    assert.equal(e.reason, 'wear');
    assert.equal(e.dueOn, '2027-05-11');
    assert.equal(e.daysLeft, 405);
    assert.equal(e.kmLeft, 22500);
    assert.equal(e.treadNowMm, 6.5);
    assert.equal(e.lastReadingOn, '2026-04-01');
    // ninety days on with nothing new, another 5,000 km and another millimetre are assumed gone
    const later = estimate([visit(90, 5000, 6.5)], day(180));
    assert.equal(later.dueOn, '2027-05-11');
    assert.equal(later.treadNowMm, 5.5);
    assert.equal(later.daysLeft, 315);
  });

  test('without an odometer the distance to a reading is judged from the time since fitting', () => {
    assert.equal(estimate([visit(120, null, 6.6)], day(120)).basis, 'typical', 'about 3,900 km at the typical pace');
    const e = estimate([visit(180, null, 6.0)], day(180));
    assert.equal(e.basis, 'readings', 'about 5,900 km at the typical pace');
    assert.equal(e.kmPerMonthMeasured, false);
    assert.equal(e.daysLeft, 480, '1.5 mm in 180 days, 4 mm left');
  });

  test('several readings are fitted together, not just the last one', () => {
    // 0 km 7.5 mm, 10,000 km 6.5 mm, 20,000 km 5.5 mm: a steady 1 mm per 10,000 km over 200 days
    const steady = estimate([visit(100, 10000, 6.5), visit(200, 20000, 5.5)], day(200));
    assert.equal(steady.basis, 'readings');
    assert.equal(steady.readings, 3);
    assert.equal(steady.kmLeft, 35000, '3.5 mm left at 1 mm per 10,000 km');
    assert.equal(steady.daysLeft, 350);
    // an early reading that showed little wear pulls the line: 0 km 7.5, 5,000 km 7.3, 20,000 km 5.5.
    // The best line through all three wears 1.046 mm per 10,000 km, so 3.5 mm lasts 33,456 km, not 35,000
    const bent = estimate([visit(50, 5000, 7.3), visit(200, 20000, 5.5)], day(200));
    assert.equal(bent.readings, 3);
    assert.equal(bent.daysLeft, 335);
    assert.equal(bent.kmLeft, 33500);
    // and the order the visits arrive in makes no difference
    assert.deepEqual(estimate([visit(200, 20000, 5.5), visit(50, 5000, 7.3)], day(200)), bent);
  });

  test('a slip of the gauge cannot promise far more than 2.5 times the typical life', () => {
    // 20,000 km in 100 days and the gauge says only 0.1 mm has gone. Taken at face value: over a million km.
    const e = estimate([visit(100, 20000, 7.4)], day(100));
    assert.equal(e.basis, 'readings');
    assert.equal(e.reason, 'wear', 'held back by the wear limit, not by the age limit');
    assert.equal(e.kmLeft, 110400, '5.4 mm left at no slower than 5.5 mm per 112,500 km');
    assert.equal(e.daysLeft, 552);
    // a reading higher than new is held to the same limit: 5.6 mm at no slower than 5.5 mm per 112,500 km
    const up = estimate([visit(100, 20000, 7.6)], day(100));
    assert.equal(up.basis, 'readings');
    assert.equal(up.reason, 'wear');
    assert.equal(up.kmLeft, 114600);
    assert.equal(up.daysLeft, 573);
    assert.equal(up.treadNowMm, 7.5, 'and the tread shown never goes above a new tyre');
  });

  test('readings that show no wear at all count as the slowest wear allowed, not as typical wear', () => {
    // 20,000 km in 200 days, 100 km a day, and the gauge still says 7.5 mm, the same as new. The slowest wear
    // allowed is 5.5 mm per 112,500 km (2.5 times the typical life), so the 5.5 mm to go lasts 1,125 days.
    // Going back to typical wear here would say 45,000 km: less than a reading of 7.4 mm gets.
    const same = estimate([visit(200, 20000, 7.5)], day(200));
    assert.equal(same.basis, 'readings');
    assert.equal(same.readings, 2);
    assert.equal(same.reason, 'wear');
    assert.equal(same.kmLeft, 112500);
    assert.equal(same.daysLeft, 1125);
    assert.equal(same.dueOn, day(1325));
    assert.equal(same.treadNowMm, 7.5);
    // a hair of wear lands just before it, and a reading above new just after: 5.4 mm and 5.6 mm at the same rate
    const hair = estimate([visit(200, 20000, 7.4)], day(200));
    assert.deepEqual([hair.daysLeft, hair.kmLeft], [1105, 110500]);
    const up = estimate([visit(200, 20000, 7.6)], day(200));
    assert.deepEqual([up.daysLeft, up.kmLeft], [1145, 114500]);
    // several readings that all show the same depth are no different
    const flat = estimate([visit(100, 10000, 7.5), visit(200, 20000, 7.5)], day(200));
    assert.equal(flat.readings, 3);
    assert.deepEqual([flat.daysLeft, flat.kmLeft], [1125, 112500]);
    // a hundred days and 10,000 km on with nothing new, the slowest wear is taken off: 7.5 less 0.49 mm
    const later = estimate([visit(200, 20000, 7.5)], day(300));
    assert.equal(later.dueOn, same.dueOn);
    assert.equal(later.treadNowMm, 7);
  });

  test('a slip of the gauge cannot condemn a tyre faster than 2.5 times the typical wear', () => {
    // 4.5 mm gone in 5,000 km over 150 days. At face value 1 mm more would last 33 days; the limit gives 98
    const e = estimate([visit(150, 5000, 3.0)], day(150));
    assert.equal(e.basis, 'readings');
    assert.equal(e.daysLeft, 98);
    assert.equal(e.kmLeft, 3300);
    assert.equal(e.atLimit, false);
  });

  test('tyres are due at six years whatever the tread says', () => {
    // 2,400 km in the first year: at that pace the tread would last decades
    const e = estimate([visit(365, 2400, null)], day(365));
    assert.equal(e.reason, 'age');
    const pastSixYears = est.toDay(e.dueOn) - est.toDay('2032-01-01');
    assert.ok(pastSixYears === 0 || pastSixYears === 1, `due ${e.dueOn}, six years after fitting`);
    // the same with a healthy tread reading in hand
    const read = estimate([visit(365, 2400, null), visit(1500, 9900, 6.6)], day(1500));
    assert.equal(read.basis, 'readings');
    assert.equal(read.reason, 'age');
    assert.equal(read.dueOn, e.dueOn);
    // and a typical driver is not caught by it
    assert.equal(estimate([], FIT).reason, 'wear');
  });

  test('a tyre measured at or below the replacement depth is due on the day it was measured', () => {
    for (const mm of [2.0, 1.9]) {
      const e = estimate([visit(400, 30000, mm)], day(410));
      assert.equal(e.basis, 'readings');
      assert.equal(e.dueOn, day(400));
      assert.equal(e.daysLeft, -10);
      assert.equal(e.kmLeft, 0);
      assert.equal(e.atLimit, false, `${mm} mm is worn but still above the legal 1.6 mm`);
    }
    // even early on, before 5,000 km: a tyre measured as worn out is worn out
    for (const mm of [2.0, 1.8]) {
      const early = estimate([visit(20, 900, mm)], day(20));
      assert.equal(early.basis, 'readings', `${mm} mm at 900 km`);
      assert.equal(early.daysLeft, 0, `${mm} mm at 900 km`);
    }
    // just above the mark the basis stays typical, but the date is no later than 0.1 mm lasts at typical wear:
    // 818 km, 18 days at 900 km per 20 days. With the odometer reading alone it would be 980 days.
    const justAbove = estimate([visit(20, 900, 2.1)], day(20));
    assert.equal(justAbove.basis, 'typical');
    assert.equal(justAbove.daysLeft, 18);
    assert.equal(justAbove.treadNowMm, 2.1);
    assert.equal(justAbove.atLimit, false);
    assert.equal(estimate([visit(20, 900, null)], day(20)).daysLeft, 980);
  });

  test('the legal limit flag is raised by a real reading at or below the limit', () => {
    assert.equal(estimate([visit(400, 30000, 1.7)], day(400)).atLimit, false);
    assert.equal(estimate([visit(400, 30000, 1.6)], day(400)).atLimit, true);
    assert.equal(estimate([visit(400, 30000, 0.9)], day(400)).atLimit, true);
    assert.equal(estimate([visit(400, 30000, 0)], day(400)).atLimit, true);
    // the latest reading decides
    assert.equal(estimate([visit(390, 29000, 1.5), visit(400, 30000, 2.4)], day(400)).atLimit, false);
  });

  test('the legal limit flag is never raised by an estimate alone', () => {
    // fitted long ago, never measured: the estimate says the tread is gone, but nobody has looked
    const old = estimate([], '2032-06-01');
    assert.equal(old.basis, 'typical');
    assert.equal(old.treadNowMm, 0, 'the estimated tread stops at zero');
    assert.ok(old.daysLeft < 0);
    assert.equal(old.kmLeft, 0);
    assert.equal(old.atLimit, false);
    // measured once at 2.5 mm, then not seen for years: worn out on paper, still not flagged
    const stale = estimate([visit(300, 30000, 2.5)], day(2000));
    assert.equal(stale.basis, 'readings');
    assert.equal(stale.treadNowMm, 0);
    assert.equal(stale.lastReadingMm, 2.5);
    assert.equal(stale.atLimit, false);
    // odometer readings alone never raise it either
    assert.equal(estimate([visit(900, 80000, null)], day(900)).atLimit, false);
  });

  test('two-wheelers have their own numbers and their own legal limit', () => {
    const scooter = carSale({ size: '90/100-10' });
    const fresh = estimate([], FIT, scooter);
    assert.equal(fresh.profile, 'two-wheeler');
    assert.equal(fresh.kmPerMonth, 800);
    assert.equal(fresh.treadNowMm, 5);
    assert.equal(fresh.legalMinMm, 0.8);
    assert.equal(fresh.daysLeft, 1141, '30,000 km at 800 km a month is 37.5 months');
    // 1.2 mm: fine on a scooter (limit 0.8), over the limit on a car (1.6)
    assert.equal(estimate([visit(400, 9000, 1.2)], day(400), scooter).atLimit, false);
    assert.equal(estimate([visit(400, 9000, 1.2)], day(400)).atLimit, true);
    assert.equal(estimate([visit(400, 9000, 0.8)], day(400), scooter).atLimit, true);
  });

  test('whatever mix of readings comes in, the estimate stays within sane bounds', () => {
    // a fixed sequence of made-up histories: the same every run
    let seed = 20261006;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const fit = est.toDay(FIT), oldest = fit + Math.round(TYRES.maxAgeYears * 365.25);
    for (let i = 0; i < 3000; i++) {
      const size = rnd() < 0.5 ? '185/65 R15' : '90/100-10';
      const profile = est.profileFor(size, TYRES);
      const sale = carSale({ size, new_tread_mm: rnd() < 0.3 ? Math.round((profile.replaceAtMm + 1.1 + rnd() * 6) * 10) / 10 : null });
      const newTread = sale.new_tread_mm == null ? profile.newTreadMm : sale.new_tread_mm;
      const visits = [];
      let days = 0, km = 0;
      for (let n = Math.floor(rnd() * 5); n > 0; n--) {
        days += Math.floor(rnd() * 400);
        km += Math.floor(rnd() * 20000);
        visits.push(visit(days, rnd() < 0.7 ? km : null, rnd() < 0.6 ? Math.round(rnd() * (newTread + 1) * 10) / 10 : null));
      }
      const today = day(days + Math.floor(rnd() * 3000));
      const treads = visits.filter(v => v.tread_mm != null);
      const e = est.estimateSale(sale, [purchase, ...visits], TYRES, today);
      const wrong = [];
      if (!validDay(e.dueOn)) wrong.push('dueOn is not a day');
      else {
        if (est.toDay(e.dueOn) < fit) wrong.push('due before the tyres were fitted');
        if (est.toDay(e.dueOn) > oldest) wrong.push('due after the age limit');
        if (e.daysLeft !== est.toDay(e.dueOn) - est.toDay(today)) wrong.push('daysLeft does not match dueOn');
      }
      if (!(e.treadNowMm >= 0 && e.treadNowMm <= newTread)) wrong.push('tread outside 0 to new');
      if (treads.length && e.lastReadingMm !== treads[treads.length - 1].tread_mm) wrong.push('lastReadingMm is not the latest reading');
      if (treads.length && e.treadNowMm > e.lastReadingMm) wrong.push('tread now is above what the gauge last found');
      if (!(e.kmLeft >= 0) || e.kmLeft % 100 !== 0) wrong.push('kmLeft');
      if (!(e.kmPerMonth >= 50 && e.kmPerMonth <= 30000)) wrong.push('kmPerMonth');
      if (e.basis === 'readings' && !treads.length) wrong.push('"readings" with no tread reading');
      if (e.atLimit !== (treads.length > 0 && e.lastReadingMm <= profile.legalMinMm)) wrong.push('atLimit does not follow the last real reading');
      if (!['wear', 'age'].includes(e.reason) || !['typical', 'readings'].includes(e.basis)) wrong.push('labels');
      if (wrong.length) assert.fail(`${wrong.join('; ')}\n${JSON.stringify({ sale, visits, today, estimate: e }, null, 1)}`);
    }
  });

  test('a lower tread reading never pushes the replacement date later', () => {
    const dueAt = mm => est.toDay(estimate([visit(100, 20000, mm)], day(100)).dueOn);
    const readings = [7.6, 7.5, 7.4, 7.0, 6.0, 5.0, 4.0, 3.0, 2.1, 2.0, 1.0];
    for (let i = 1; i < readings.length; i++) {
      assert.ok(dueAt(readings[i]) <= dueAt(readings[i - 1]), `${readings[i]} mm is due ${est.fromDay(dueAt(readings[i]))}, later than ${readings[i - 1]} mm which is due ${est.fromDay(dueAt(readings[i - 1]))}`);
    }
    // the reading that is the same as new sits between its neighbours, where the old jump back to typical wear was
    assert.ok(dueAt(7.5) > dueAt(7.4) && dueAt(7.5) < dueAt(7.6), `7.6 mm ${est.fromDay(dueAt(7.6))}, 7.5 mm ${est.fromDay(dueAt(7.5))}, 7.4 mm ${est.fromDay(dueAt(7.4))}`);

    // and the same at every point in a tyre's life: early or late, with or without an odometer, with or without
    // an earlier reading, for every depth a gauge can show from above new down to bald
    for (const sale of [carSale(), carSale({ new_tread_mm: 8.2 }), carSale({ size: '90/100-10' })]) {
      for (const days of [5, 20, 90, 200, 900, 2100]) {
        for (const km of [null, 900, 4999, 5000, 20000, 150000]) {
          for (const before of [[], [visit(Math.ceil(days / 2), km == null ? null : Math.floor(km / 2), 6.0)]]) {
            let prev = Infinity, prevMm = null;
            for (let tenths = 92; tenths >= 0; tenths--) {
              const mm = tenths / 10;
              const due = est.toDay(estimate([...before, visit(days, km, mm)], day(days), sale).dueOn);
              if (due > prev) assert.fail(`${sale.size}, ${days} days and ${km} km after fitting${before.length ? ', with an earlier reading' : ''}: ${mm} mm is due ${est.fromDay(due)}, later than ${prevMm} mm which is due ${est.fromDay(prev)}`);
              prev = due; prevMm = mm;
            }
          }
        }
      }
    }
  });

  test('with the shipped settings a new car tyre is due in years, not days or decades', () => {
    const e = est.estimateSale(carSale(), [purchase], shipped().tyres, FIT);
    assert.equal(e.basis, 'typical');
    assert.ok(e.daysLeft > 365 && e.daysLeft <= shipped().tyres.maxAgeYears * 366, `${e.daysLeft} days`);
    assert.equal(e.atLimit, false);
  });
});

describe('estimate: services due', () => {
  const REMINDERS = {
    services: [
      { key: 'rotation', name: 'Tyre rotation', everyKm: 5000, everyMonths: 6, for: ['car'] },
      { key: 'pressure-check', name: 'Pressure check', everyKm: 20000, everyMonths: 2 },   // no "for": every tyre
    ],
  };
  const due = (visits, profile, kmPerMonth, today) => est.servicesDue(carSale(), visits, REMINDERS, profile, kmPerMonth, today);
  const byKey = list => Object.fromEntries(list.map(s => [s.key, s]));

  test('a service is due by distance when the customer drives enough, counted from fitting day', () => {
    const s = byKey(due([purchase], 'car', 1000, FIT));
    assert.equal(s.rotation.by, 'distance');
    assert.equal(s.rotation.dueOn, '2026-06-02', '5,000 km at 1,000 km a month is five months');
    assert.equal(s.rotation.daysLeft, 152);
    assert.equal(s.rotation.lastDoneOn, null);
    assert.equal(s['pressure-check'].by, 'time');
    assert.equal(s['pressure-check'].dueOn, '2026-03-03', 'two months, long before 20,000 km');
  });

  test('a service is due by time when the customer drives little', () => {
    const s = byKey(due([purchase], 'car', 500, FIT));
    assert.equal(s.rotation.by, 'time');
    assert.equal(s.rotation.dueOn, '2026-07-03', 'six months, before 5,000 km at 500 km a month');
  });

  test('the clock restarts from the day the service was last done, for that service only', () => {
    const done = visit(59, 2000, null, { services: ['rotation'] });                   // 2026-03-01
    const s = byKey(due([purchase, done], 'car', 1000, '2026-03-01'));
    assert.equal(s.rotation.lastDoneOn, '2026-03-01');
    assert.equal(s.rotation.dueOn, '2026-07-31');
    assert.equal(s.rotation.daysLeft, 152);
    assert.equal(s['pressure-check'].lastDoneOn, null);
    assert.equal(s['pressure-check'].dueOn, '2026-03-03');
    // the latest of several counts
    const twice = byKey(due([purchase, visit(100, 3000, null, { services: ['rotation'] }), done], 'car', 1000, day(100)));
    assert.equal(twice.rotation.lastDoneOn, day(100));
  });

  test('a new odometer reading moves the date a service is due, but never the day it was last done', () => {
    // the staff reminder for a service is filed under the day it was last done (fitting day when never), so that
    // day has to stay put while the customer's monthly distance, and with it the due date, moves about
    const done = visit(59, 2000, null, { services: ['rotation'] });                   // 2026-03-01
    const paces = [500, 1000, 2500];
    const after = paces.map(kmPerMonth => byKey(due([purchase, done], 'car', kmPerMonth, day(100))).rotation);
    assert.deepEqual(after.map(s => s.dueOn), ['2026-08-31', '2026-07-31', '2026-05-01'], 'six months, five months, two months');
    assert.deepEqual(after.map(s => s.by), ['time', 'distance', 'distance']);
    assert.deepEqual(after.map(s => s.lastDoneOn), ['2026-03-01', '2026-03-01', '2026-03-01']);
    // never done: the date moves just the same, and there is no last day at any pace
    const never = paces.map(kmPerMonth => byKey(due([purchase], 'car', kmPerMonth, day(100))).rotation);
    assert.deepEqual(never.map(s => s.dueOn), ['2026-07-03', '2026-06-02', '2026-03-03']);
    assert.deepEqual(never.map(s => s.lastDoneOn), [null, null, null]);
    // a later visit with a reading but without the service leaves the day alone as well
    const reading = visit(90, 9000, 6.8);
    assert.equal(byKey(due([purchase, done, reading], 'car', 3000, day(100))).rotation.lastDoneOn, '2026-03-01');
  });

  test('a rotation done on the old tyres does not count for the new set', () => {
    const before = visit(-12, null, null, { services: ['rotation'] });
    const s = byKey(due([before, purchase], 'car', 1000, FIT));
    assert.equal(s.rotation.lastDoneOn, null);
    assert.equal(s.rotation.dueOn, '2026-06-02');
  });

  test('an overdue service shows how many days it is overdue', () => {
    assert.equal(byKey(due([purchase], 'car', 1000, '2026-07-01')).rotation.daysLeft, -29);
  });

  test('a service applies only to the tyre kinds it is for', () => {
    assert.deepEqual(due([purchase], 'car', 1000, FIT).map(s => s.key), ['rotation', 'pressure-check']);
    assert.deepEqual(due([purchase], 'two-wheeler', 800, FIT).map(s => s.key), ['pressure-check']);
    assert.deepEqual(due([purchase], 'truck', 6000, FIT).map(s => s.key), ['pressure-check']);
  });

  test('with the shipped settings a scooter is never told a rotation or alignment check is due, and a car is', () => {
    const r = shipped().reminders;
    const forCar = est.servicesDue(carSale(), [purchase], r, 'car', 1000, FIT).map(s => s.key);
    assert.ok(forCar.includes('rotation') && forCar.includes('alignment-check'), forCar.join());
    const forScooter = est.servicesDue(carSale({ size: '90/100-10' }), [purchase], r, 'two-wheeler', 800, FIT).map(s => s.key);
    assert.ok(!forScooter.includes('rotation') && !forScooter.includes('alignment-check'), forScooter.join());
  });
});

describe('estimate: which kind of tyre a size is (shipped settings)', () => {
  const kind = size => est.profileFor(size, shipped().tyres).key;

  test('car sizes', () => {
    for (const size of ['185/65 R15', '215/60 R16', '195/55 R16', '165/80 R14', '145/80 R12', '205/55R16', '265/65 R17', '155 R13', '185/65 r15']) {
      assert.equal(kind(size), 'car', size);
    }
  });

  test('scooter and motorcycle sizes', () => {
    for (const size of ['90/100-10', '90/90-12', '100/90-17', '110/80-17', '120/80-18', '140/70-17', '80/100-18', '2.75-18', '3.00-18', '3.50-10', '2.50-16', '3.25-19', '4.00-10', '90/90 - 12']) {
      assert.equal(kind(size), 'two-wheeler', size);
    }
  });

  test('truck and bus sizes', () => {
    for (const size of ['10.00-20', '10.00 R20', '10.00 r20', '9.00-16', '7.50-16', '6.50-20', '8.25-16', '11.00-20', '13.00-24', '295/80 R22.5', '11R22.5', '235/75 R17.5']) {
      assert.equal(kind(size), 'truck', size);
    }
  });

  test('every size gets a profile, even one nobody planned for', () => {
    for (const size of ['12.4-28', '31X10.5 R15', '7', '999']) assert.equal(typeof kind(size), 'string', size);
  });

  test('three-wheeler and motorcycle sizes outside the common pattern are still two-wheelers', () => {
    // a one-digit rim (auto-rickshaw), a bias-belted rim (B), and radial motorcycle sizes
    for (const size of ['4.00-8', '3.50-8', '150/80B16', '140/70 R17', '150/60 R17', '110/70 R17', '120/70 ZR17']) assert.equal(kind(size), 'two-wheeler', size);
    // which is what gives them the two and three wheeler legal limit instead of the car one
    const tyres = shipped().tyres;
    assert.ok(est.profileFor('4.00-8', tyres).legalMinMm < est.profileFor('185/65 R15', tyres).legalMinMm);
    // widening the two-wheeler pattern did not take any car or truck size with it
    for (const size of ['185/65 R15', '205/55 R16', '215/60 R17', '225/45 ZR17', '235/65 R17', '195/55 R16', '155/80 R13']) assert.equal(kind(size), 'car', size);
    for (const size of ['10.00-20', '9.00 R20', '7.50-16', '295/80 R22.5']) assert.equal(kind(size), 'truck', size);
  });

  test('a size typed with its ply rating or load index keeps its kind', () => {
    const size = is.size('size');
    const pairs = [
      ['10.00-20', '10.00-20 16PR', 'truck'], ['7.50-16', '7.50-16 LT', 'truck'], ['295/80 R22.5', '295/80 R22.5 152M', 'truck'],
      ['90/100-10', '90/100-10 53J', 'two-wheeler'], ['2.75-18', '2.75-18 6PR', 'two-wheeler'], ['4.00-8', '4.00-8 6PR', 'two-wheeler'], ['100/90-18', '100/90-18 M/C 56P', 'two-wheeler'],
      ['185/65 R15', '185/65 R15 88H', 'car'], ['205/55 R16', '205/55 ZR16 91W', 'car'], ['195 R15', '195 R15 C', 'car'],
    ];
    for (const [bare, withSuffix, want] of pairs) {
      assert.equal(kind(size(bare)), want, bare);
      assert.equal(kind(size(withSuffix)), want, `${withSuffix} is accepted by the size check and must still be a ${want} tyre`);
      assert.equal(kind(size(withSuffix.toLowerCase())), want, `${withSuffix} typed in small letters`);
    }
  });
});

describe('estimate: the size itself, without what is written after it', () => {
  test('load index, speed letter and ply rating are left off, and a radial is written with R', () => {
    const cores = {
      '185/65 R15': '185/65R15', '185/65R15': '185/65R15', '185/65 r15': '185/65R15', '185/65 R15 88H': '185/65R15',
      '185/65/15': '185/65R15', '205/55 ZR16 91W': '205/55R16', '155 R13': '155R13', '195 R15 C': '195R15',
      '90/100-10': '90/100-10', '90/100-10 53J': '90/100-10', '90/90 - 12': '90/90-12', '100/90-18 M/C 56P': '100/90-18',
      '150/80B16': '150/80B16', '150/80 B16 77H': '150/80B16', '2.75-18 6PR': '2.75-18', '4.00-8 6PR': '4.00-8',
      '10.00-20 16PR': '10.00-20', '10.00 R20': '10.00R20', '7.50-16 LT': '7.50-16',
      '295/80 R22.5': '295/80R22.5', '295/80 R22.5 152M': '295/80R22.5', '11R22.5 16PR': '11R22.5',
      '  185/65  R15  ': '185/65R15',
    };
    for (const [typed, core] of Object.entries(cores)) assert.equal(est.coreSize(typed), core, util.inspect(typed));
    // a size it cannot read is matched as it was typed, with the spaces out
    assert.equal(est.coreSize('31X10.5 R15'), '31X10.5R15');
    assert.equal(est.coreSize('999'), '999');
  });

  test('with fixed profiles a size keeps its kind and its estimate whatever is written after it', () => {
    for (const size of ['90/100-10', '90/100-10 53J', '90/100-10 53J TL', '3.00-18 6PR', '100/90-17 M/C 55P', '90/90 - 12']) assert.equal(est.profileFor(size, TYRES).key, 'two-wheeler', size);
    for (const size of ['185/65 R15', '185/65 R15 88H', '185/65/15', '205/55 ZR16 91W']) assert.equal(est.profileFor(size, TYRES).key, 'car', size);
    // a pattern is matched against the size alone, so one that ends at the rim still matches a size with a suffix,
    // and a suffix cannot make a size match a pattern meant for something else
    const tyres = { ...TYRES, profiles: [{ ...TYRES.profiles[0], sizeMatch: '^\\d{2,3}/\\d{2,3}-\\d{2}$' }, { ...TYRES.profiles[1], key: 'radial', sizeMatch: 'R' }, { ...TYRES.profiles[1], key: 'other' }] };
    assert.equal(est.profileFor('90/100-10 53J', tyres).key, 'two-wheeler');
    assert.equal(est.profileFor('185/65 R15 88H', tyres).key, 'radial');
    assert.equal(est.profileFor('185/65 r15', tyres).key, 'radial');
    assert.equal(est.profileFor('10.00-20', tyres).key, 'other');
    assert.equal(est.profileFor('10.00-20 16PR', tyres).key, 'other', 'the R in 16PR is not part of the size');
    assert.equal(est.profileFor('2.75-18 6PR', tyres).key, 'other');
    // a scooter sale saved with its load index gets the scooter numbers, the same as one saved without
    const withSuffix = estimate([visit(400, 9000, 1.2)], day(400), carSale({ size: '90/100-10 53J' }));
    assert.equal(withSuffix.profile, 'two-wheeler');
    assert.equal(withSuffix.legalMinMm, 0.8);
    assert.equal(withSuffix.atLimit, false, '1.2 mm is above the two-wheeler limit; on the car profile it would be flagged');
    assert.deepEqual(withSuffix, estimate([visit(400, 9000, 1.2)], day(400), carSale({ size: '90/100-10' })));
  });
});

describe('estimate: the nearest shop for the breakdown button', () => {
  const LUDHIANA = { id: 'ludhiana', name: 'Ludhiana', phone: '+918303400005', address: 'New Market', lat: 30.9122, lng: 75.8483 };
  const JALANDHAR = { id: 'jalandhar', name: 'Jalandhar', phone: '+918303400006', address: 'GT Road', lat: 31.326, lng: 75.5762 };
  const AMRITSAR = { id: 'amritsar', name: 'Amritsar', phone: '+918303400007', address: 'Mall Road', lat: 31.634, lng: 74.8723 };

  test('the closest shop is picked, with the distance to it', () => {
    const shops = [LUDHIANA, JALANDHAR, AMRITSAR];
    const nearJalandhar = est.nearestShop(shops, 31.28, 75.6);          // Phagwara side of Jalandhar
    assert.equal(nearJalandhar.shop.id, 'jalandhar');
    assert.ok(nearJalandhar.km > 3 && nearJalandhar.km < 8, `${nearJalandhar.km} km`);
    assert.equal(est.nearestShop(shops, 30.9, 75.85).shop.id, 'ludhiana');
    assert.equal(est.nearestShop(shops, 31.62, 74.88).shop.id, 'amritsar');
    assert.equal(est.nearestShop([AMRITSAR, JALANDHAR, LUDHIANA], 30.9, 75.85).shop.id, 'ludhiana', 'whatever order they are listed in');
    assert.equal(est.nearestShop(shops, LUDHIANA.lat, LUDHIANA.lng).km, 0);
  });

  test('distances are real road-map distances, not degrees', () => {
    const km = est.distanceKm(LUDHIANA.lat, LUDHIANA.lng, JALANDHAR.lat, JALANDHAR.lng);
    assert.ok(km > 50 && km < 56, `Ludhiana to Jalandhar is about 53 km in a straight line, got ${km}`);
    const delhi = est.nearestShop([LUDHIANA], 28.6139, 77.209);
    assert.ok(delhi.km > 270 && delhi.km < 300, `Delhi to Ludhiana is about 285 km, got ${delhi.km}`);
  });

  test('with no location the first shop is given and no distance is claimed', () => {
    const shops = [LUDHIANA, JALANDHAR];
    assert.deepEqual(est.nearestShop(shops, null, null), { shop: LUDHIANA, km: null });
    assert.deepEqual(est.nearestShop(shops, undefined, undefined), { shop: LUDHIANA, km: null });
    assert.deepEqual(est.nearestShop(shops, 31.3, null), { shop: LUDHIANA, km: null }, 'half a location is no location');
  });

  test('a location of exactly zero is still a location', () => {
    const got = est.nearestShop([LUDHIANA, JALANDHAR], 0, 0);
    assert.equal(typeof got.km, 'number');
    assert.ok(got.km > 5000);
  });

  test('the shipped settings always give a shop to call', () => {
    const shops = shipped().shops;
    const there = est.nearestShop(shops, 30.8721, 75.8912);
    assert.ok(shops.includes(there.shop));
    assert.match(there.shop.phone, /^\+\d{10,15}$/);
    assert.equal(est.nearestShop(shops, null, null).shop, shops[0]);
  });
});

describe('estimate: the shop\'s calendar', () => {
  test('today is the day in the shop\'s time zone, not the server\'s', () => {
    const IST = 330;
    assert.equal(est.today(Date.UTC(2026, 9, 5, 18, 29, 59), IST), '2026-10-05', '23:59 in Ludhiana');
    assert.equal(est.today(Date.UTC(2026, 9, 5, 18, 30, 0), IST), '2026-10-06', 'midnight in Ludhiana');
    assert.equal(est.today(Date.UTC(2026, 9, 5, 18, 30, 0), 0), '2026-10-05');
  });

  test('adding days and months follows the calendar', () => {
    assert.equal(est.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(est.addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(est.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(est.addMonths('2026-01-31', 1), '2026-02-28', 'a warranty from the 31st ends on the last day of a short month');
    assert.equal(est.addMonths('2024-02-29', 12), '2025-02-28');
    assert.equal(est.addMonths('2026-10-06', 60), '2031-10-06', 'a 60 month warranty');
    assert.equal(est.addMonths('2026-10-06', 0), '2026-10-06');
  });
});
