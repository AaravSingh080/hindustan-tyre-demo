'use strict';

/* Staff accounts: each person at the counter has a name and their own PIN, so the audit trail and every sale
   say who did it. The owner's PIN is STAFF_PIN from the server settings and is not in the database; it alone
   opens the owner's page. PINs are kept as keyed hashes (APP_SECRET), never as digits. */

const crypto = require('node:crypto');
const { tx, audit } = require('./db');
const { Invalid } = require('./validate');
const { weakPin, DEMO_STAFF_PINS } = require('./config');

// a problem with what the owner typed: answered like any other invalid field
class StaffProblem extends Invalid {}

const NAME_RE = /^[\p{L}][\p{L}\p{M}\d' .()-]{1,39}$/u;

function makeStaff(cfg, hk) {
  const hash = pin => hk('spin|' + pin);
  const ownerHash = () => hk('spin|' + cfg.staffPin);
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  function checkName(name) {
    if (typeof name !== 'string') throw new StaffProblem('name', 'Enter the name.');
    const t = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!NAME_RE.test(t)) throw new StaffProblem('name', 'Enter a name of 2 to 40 letters.');
    return t;
  }
  function checkPin(db, pin, exceptId) {
    if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin)) throw new StaffProblem('pin', 'A PIN is 6 to 12 digits.');
    // the demo's sample PINs are printed in the code: fine for the demo's own sample staff, never on a live site
    if (weakPin(pin) || (cfg.mode === 'live' && DEMO_STAFF_PINS.includes(pin))) throw new StaffProblem('pin', 'That PIN is too easy to guess. Avoid repeats, straight runs and dates.');
    const h = hash(pin);
    if (same(h, ownerHash())) throw new StaffProblem('pin', 'That PIN is already in use. Choose another.');
    const clash = db.q('SELECT id FROM staff WHERE pin_hash = ?').get(h);
    if (clash && clash.id !== exceptId) throw new StaffProblem('pin', 'That PIN is already in use. Choose another.');
    return h;
  }

  const view = r => ({ id: r.id, name: r.name, active: !!r.active, createdAt: r.created_at, lastLogin: r.last_login });

  return {
    StaffProblem,
    // who typed this PIN: the owner, an active member of staff, or nobody. Every hash is compared, so the time
    // taken does not say which one was right.
    match(db, pin) {
      const h = hash(pin);
      let found = same(h, ownerHash()) ? { id: null, name: 'Owner', role: 'owner' } : null;
      for (const r of db.q('SELECT id, name, pin_hash, active FROM staff').all()) {
        if (same(h, r.pin_hash) && r.active && !found) found = { id: r.id, name: r.name, role: 'staff' };
      }
      return found;
    },
    list: db => db.q('SELECT * FROM staff ORDER BY active DESC, name COLLATE NOCASE').all().map(view),
    byId: (db, id) => { const r = db.q('SELECT * FROM staff WHERE id = ?').get(id); return r ? view(r) : null; },
    create(db, { name, pin }, actor, now) {
      const n = checkName(name);
      return tx(db, () => {
        if (db.q('SELECT COUNT(*) AS c FROM staff WHERE active = 1').get().c >= 50) throw new StaffProblem('name', 'Fifty active staff accounts is the most this page keeps.');
        if (db.q('SELECT 1 FROM staff WHERE name = ? COLLATE NOCASE AND active = 1').get(n)) throw new StaffProblem('name', 'Someone with this name already has an account. Add an initial to tell them apart.');
        const h = checkPin(db, pin);
        const id = Number(db.q('INSERT INTO staff (name, pin_hash, active, created_at) VALUES (?, ?, 1, ?)').run(n, h, now).lastInsertRowid);
        audit(db, now, actor, 'staff.create', { staff: id });
        return view(db.q('SELECT * FROM staff WHERE id = ?').get(id));
      });
    },
    rename(db, id, name, actor, now) {
      const n = checkName(name);
      return tx(db, () => {
        const r = db.q('SELECT * FROM staff WHERE id = ?').get(id);
        if (!r) throw new StaffProblem('id', 'That account was not found.');
        db.q('UPDATE staff SET name = ? WHERE id = ?').run(n, id);
        db.q('UPDATE sessions SET staff_name = ? WHERE staff_id = ?').run(n, id);
        audit(db, now, actor, 'staff.rename', { staff: id });
        return view({ ...r, name: n });
      });
    },
    // a new PIN signs that person out everywhere
    resetPin(db, id, pin, actor, now) {
      return tx(db, () => {
        const r = db.q('SELECT * FROM staff WHERE id = ?').get(id);
        if (!r) throw new StaffProblem('id', 'That account was not found.');
        const h = checkPin(db, pin, id);
        db.q('UPDATE staff SET pin_hash = ? WHERE id = ?').run(h, id);
        db.q('DELETE FROM sessions WHERE staff_id = ?').run(id);
        audit(db, now, actor, 'staff.pin', { staff: id });
        return view(r);
      });
    },
    setActive(db, id, active, actor, now) {
      return tx(db, () => {
        const r = db.q('SELECT * FROM staff WHERE id = ?').get(id);
        if (!r) throw new StaffProblem('id', 'That account was not found.');
        db.q('UPDATE staff SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        if (!active) db.q('DELETE FROM sessions WHERE staff_id = ?').run(id);
        audit(db, now, actor, active ? 'staff.enable' : 'staff.disable', { staff: id });
        return view({ ...r, active: active ? 1 : 0 });
      });
    },
    touch: (db, id, now) => { if (id != null) db.q('UPDATE staff SET last_login = ? WHERE id = ?').run(now, id); },
    // STAFF_PIN changed to a PIN a member already has: that member is switched off rather than becoming the owner
    disableClashes(db, now, log) {
      const clash = db.q('SELECT id, name FROM staff WHERE pin_hash = ? AND active = 1').all(ownerHash());
      for (const r of clash) {
        db.q('UPDATE staff SET active = 0 WHERE id = ?').run(r.id);
        db.q('DELETE FROM sessions WHERE staff_id = ?').run(r.id);
        audit(db, now, 'system', 'staff.disable', { staff: r.id, why: 'pin equals STAFF_PIN' });
        log(`warning: the staff account "${r.name}" had the same PIN as STAFF_PIN and was switched off. Give them a new PIN on the owner page.`);
      }
      return clash.length;
    },
    hash,
  };
}

module.exports = { makeStaff, StaffProblem };
