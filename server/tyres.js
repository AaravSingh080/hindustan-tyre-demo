'use strict';

/* The tyres the Compare page knows: an owner-edited list in config/tyres.json, checked at start-up and handed
   to the page as it is. Prices here are "from" prices the owner keeps current, or null to send people to WhatsApp. */

const fs = require('node:fs');
const { ConfigError } = require('./config');
const est = require('./estimate');

class TyresConfigError extends ConfigError {}

const TYPES = ['car', 'two-wheeler', 'truck', 'tractor', 'erickshaw'];
const need = (ok, msg) => { if (!ok) throw new TyresConfigError('config/tyres.json: ' + msg); };
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const sizeOk = s => typeof s === 'string' && /^\d[0-9A-Z ./\-]{2,19}$/i.test(s.trim());
const keyOf = size => est.coreSize(String(size)).toUpperCase().replace(/\s+/g, '');

function readTyres(file) {
  let k;
  try { k = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new TyresConfigError(`cannot read ${file}: ${e.message}`); }
  need(k && typeof k === 'object' && !Array.isArray(k), 'the file must be one JSON object');
  need(typeof k.sample === 'boolean', '"sample" must be true (examples) or false (your own list)');
  need(Array.isArray(k.tyres) && k.tyres.length <= 300, '"tyres" must be a list of up to 300 tyres');
  const ids = new Set();
  const tyres = k.tyres.map((t, i) => {
    const at = `"tyres[${i}]"`;
    need(t && typeof t === 'object', `${at} must be an object`);
    need(typeof t.id === 'string' && /^[a-z0-9][a-z0-9-]{1,39}$/.test(t.id) && !ids.has(t.id), `${at}.id must be unique: lower case letters, digits and dashes`);
    ids.add(t.id);
    need(str(t.brand, 2, 40), `${at}.brand must be 2 to 40 characters`);
    need(str(t.name, 1, 60), `${at}.name must be 1 to 60 characters`);
    need(TYPES.includes(t.type), `${at}.type must be one of ${TYPES.join(', ')}`);
    need(Array.isArray(t.sizes) && t.sizes.length >= 1 && t.sizes.length <= 60 && t.sizes.every(sizeOk), `${at}.sizes must list 1 to 60 sizes as written on the sidewall`);
    need(t.priceFrom === null || int(t.priceFrom, 1, 1000000), `${at}.priceFrom must be rupees for one tyre, or null`);
    need(int(t.warrantyMonths, 0, 120), `${at}.warrantyMonths must be 0 to 120`);
    need(t.treadLifeKm === null || int(t.treadLifeKm, 1000, 500000), `${at}.treadLifeKm must be kilometres, or null`);
    for (const f of ['wetGrip', 'noise', 'comfort']) need(int(t[f], 1, 5), `${at}.${f} must be 1 to 5`);
    need(str(t.bestFor, 3, 80), `${at}.bestFor must be 3 to 80 characters`);
    need(t.notes === undefined || t.notes === null || str(t.notes, 1, 160), `${at}.notes must be one line of up to 160 characters, or null`);
    const all = [t.brand, t.name, t.bestFor, t.notes || ''].join(' ');
    need(!/[–—<>]/.test(all), `${at} must not use dashes as punctuation or < > characters`);
    return {
      id: t.id, brand: t.brand.trim(), name: t.name.trim(), type: t.type,
      sizes: t.sizes.map(s => s.trim().toUpperCase().replace(/\s+/g, ' ')), sizeKeys: t.sizes.map(keyOf),
      priceFrom: t.priceFrom, warrantyMonths: t.warrantyMonths, treadLifeKm: t.treadLifeKm,
      wetGrip: t.wetGrip, noise: t.noise, comfort: t.comfort, bestFor: t.bestFor.trim(), notes: t.notes ? t.notes.trim() : null,
    };
  });
  return { sample: k.sample, tyres };
}

module.exports = { readTyres, keyOf, TYPES, TyresConfigError };
