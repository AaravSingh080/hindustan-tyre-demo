'use strict';

/* The Compare page: the owner's tyre list is checked at start-up and handed to the page; the finder offers the
   comparison only for picks the list can serve. */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/app');
const { readTyres, TyresConfigError, TYPES } = require('../server/tyres');
const { ConfigError } = require('../server/config');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-compare-'));
const FILE = path.join(ROOT, 'config', 'tyres.json');
const shipped = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const write = (name, obj) => { const f = path.join(TMP, name + '.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const one = (over = {}) => ({ id: 'test-tyre', brand: 'Test', name: 'Roadster', type: 'car', sizes: ['185/65 R15'], priceFrom: 4000, warrantyMonths: 60, treadLifeKm: 40000, wetGrip: 4, noise: 3, comfort: 4, bestFor: 'Testing', ...over });

async function start(opts = {}) {
  const app = createApp({ now: () => Date.UTC(2026, 9, 8, 6), env: { DATA_DIR: TMP }, log: () => {}, ...opts });
  const server = http.createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localhost:${server.address().port}`;
  const get = async p => { const r = await fetch(url + p, { redirect: 'manual' }); return { status: r.status, headers: r.headers, text: await r.text() }; };
  const stop = async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); app.close(); };
  return { app, get, stop };
}

describe('config/tyres.json', () => {
  test('the shipped list is examples, well formed, with sizes the finder knows', () => {
    const k = readTyres(FILE);
    assert.equal(k.sample, true, 'the shipped list must say it is made of examples');
    assert.ok(k.tyres.length >= 8);
    for (const t of k.tyres) {
      assert.ok(TYPES.includes(t.type));
      assert.equal(t.sizes.length, t.sizeKeys.length);
      assert.ok(t.sizeKeys.every(s => /^[0-9A-Z./-]+$/.test(s)), t.id);
    }
    assert.ok(k.tyres.filter(t => t.type === 'car' && t.sizeKeys.includes('185/65R15')).length >= 2, 'the demo size 185/65 R15 has tyres to compare');
    assert.ok(k.tyres.filter(t => t.type === 'two-wheeler').length >= 2);
  });

  test('mistakes are configuration errors with the entry named', () => {
    const cases = [
      [{ sample: true, tyres: [one({ id: 'Bad Id' })] }, /tyres\[0\]"\.id/],
      [{ sample: true, tyres: [one(), one()] }, /tyres\[1\]"\.id must be unique/],
      [{ sample: true, tyres: [one({ type: 'bus' })] }, /\.type/],
      [{ sample: true, tyres: [one({ sizes: [] })] }, /\.sizes/],
      [{ sample: true, tyres: [one({ priceFrom: 0 })] }, /\.priceFrom/],
      [{ sample: true, tyres: [one({ wetGrip: 6 })] }, /\.wetGrip/],
      [{ sample: true, tyres: [one({ bestFor: 'Long drives — and more' })] }, /dashes/],
      [{ sample: 'yes', tyres: [] }, /"sample"/],
      [{ sample: true }, /"tyres"/],
    ];
    cases.forEach(([obj, re], i) => assert.throws(() => readTyres(write('bad' + i, obj)), e => e instanceof TyresConfigError && e instanceof ConfigError && re.test(e.message), `case ${i}`));
    assert.throws(() => readTyres(path.join(TMP, 'missing.json')), /cannot read/);
    const ok = readTyres(write('ok', { sample: false, tyres: [one({ priceFrom: null, treadLifeKm: null, notes: null, sizes: [' 185/65 r15 ', '195/65R15'] })] }));
    assert.deepEqual(ok.tyres[0].sizes, ['185/65 R15', '195/65R15']);
    assert.deepEqual(ok.tyres[0].sizeKeys, ['185/65R15', '195/65R15']);
    assert.equal(ok.tyres[0].priceFrom, null);
  });
});

describe('the Compare page and its list', () => {
  let w;
  before(async () => { w = await start(); });
  after(() => w.stop());

  test('GET /api/public/tyres hands the list to anyone, exactly as checked', async () => {
    const r = await w.get('/api/public/tyres');
    assert.equal(r.status, 200);
    const d = JSON.parse(r.text);
    assert.equal(d.sample, true);
    assert.equal(d.tyres.length, shipped().tyres.length);
    assert.deepEqual(Object.keys(d.tyres[0]).sort(), ['bestFor', 'brand', 'comfort', 'id', 'name', 'noise', 'notes', 'priceFrom', 'sizeKeys', 'sizes', 'treadLifeKm', 'type', 'warrantyMonths', 'wetGrip']);
  });

  test('a server can start with its own list', async () => {
    const own = await start({ tyresFile: write('own', { sample: false, tyres: [one()] }) });
    try {
      const d = JSON.parse((await own.get('/api/public/tyres')).text);
      assert.equal(d.sample, false);
      assert.equal(d.tyres.length, 1);
    } finally { await own.stop(); }
    assert.throws(() => createApp({ env: { DATA_DIR: TMP }, tyresFile: write('broken', { sample: true, tyres: [one({ wetGrip: 0 })] }) }), ConfigError);
  });

  test('/compare/ is an app page: strict policy, the sprite, the scripts it needs', async () => {
    const r = await w.get('/compare/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.ok(r.text.includes('<symbol id="i-tire"'), 'the tyre icon is in the sprite');
    assert.ok(r.text.includes('/js/compare.js') && r.text.includes('/js/app-kit.js') && r.text.includes('/js/chat.js'));
    assert.doesNotMatch(r.text, / style="/);
    assert.doesNotMatch(r.text, /[–—]/, 'no dashes as punctuation');
    assert.equal((await w.get('/compare')).status, 308);
    for (const f of ['/css/compare.css', '/js/compare.js']) assert.equal((await w.get(f)).status, 200, f);
  });

  test('the finder knows which picks can be compared, and the home page links to Compare', () => {
    const tyres = fs.readFileSync(path.join(ROOT, 'js', 'tyres.js'), 'utf8');
    assert.ok(tyres.includes("compareType: 'car', compareSize: printed(tag)"), 'a car size pick names its size');
    assert.ok(tyres.includes("compareType: 'car' }"), 'a make and model pick names the kind');
    assert.ok(tyres.includes("scooter: 'two-wheeler', motorcycle: 'two-wheeler'"), 'scooter and bike picks compare two-wheeler tyres');
    assert.ok(tyres.includes("'/api/public/tyres'"));
    const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(home.includes('href="compare/"'));
  });
});
