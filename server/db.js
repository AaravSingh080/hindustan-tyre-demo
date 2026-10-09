'use strict';

/* SQLite through Node's built-in node:sqlite. One file on a live site, memory in demo mode.
   Days are stored as 'YYYY-MM-DD' text in the shop's own time zone; moments as epoch milliseconds. */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;
const DAY_MS = 86400e3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- no names are collected: a phone number and the vehicles it brought in.
-- AUTOINCREMENT throughout: a row id is never handed out twice, so nothing keyed to an old id can attach to a new row.
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  reminders_ok INTEGER NOT NULL DEFAULT 0,
  consent_at INTEGER,
  consent_by TEXT CHECK (consent_by IN ('customer', 'staff')),
  consent_notice TEXT,
  stopped_at INTEGER,
  stop_token TEXT NOT NULL UNIQUE,
  referral_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reg_no TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (customer_id, reg_no)
);
CREATE INDEX IF NOT EXISTS vehicles_by_reg ON vehicles (reg_no);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  tyre TEXT NOT NULL,
  size TEXT NOT NULL,
  qty INTEGER NOT NULL,
  odometer_km INTEGER NOT NULL,
  new_tread_mm REAL,
  bill_no TEXT,
  amount_paise INTEGER,
  warranty_months INTEGER NOT NULL,
  fitted_on TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  idem TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  entered_by TEXT
);
CREATE INDEX IF NOT EXISTS sales_by_vehicle ON sales (vehicle_id, fitted_on);

-- every visit: the purchase itself, and each later check or service. These are also the readings.
-- stamped = 1 when the visit put a stamp on the visit card (one a day, and only for visits entered promptly).
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase', 'service')),
  visited_on TEXT NOT NULL,
  odometer_km INTEGER,
  tread_mm REAL,
  services TEXT NOT NULL DEFAULT '[]',
  stamped INTEGER NOT NULL DEFAULT 0,
  idem TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  entered_by TEXT
);
CREATE INDEX IF NOT EXISTS visits_by_vehicle ON visits (vehicle_id, visited_on);
CREATE INDEX IF NOT EXISTS visits_by_customer ON visits (customer_id, visited_on);

-- a free service a customer has earned; used_at is set once by staff
CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('card', 'referral')),
  ref TEXT NOT NULL,
  earned_at INTEGER NOT NULL,
  used_at INTEGER,
  UNIQUE (customer_id, source, ref)
);

-- the friend is known only by the number they signed in with until staff register their first purchase
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  friend_phone TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  converted_at INTEGER
);

-- what staff did with a prepared reminder. There is deliberately no 'sent' state the server sets itself.
CREATE TABLE IF NOT EXISTS reminder_log (
  key TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('opened', 'marked_sent', 'skipped')),
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS breakdowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  lat REAL,
  lng REAL,
  accuracy_m REAL,
  shop_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER
);

-- sign-in codes and counters are kept under a keyed hash of the phone or address, never the value itself
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY,
  phone_key TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS otp_by_phone ON otp_codes (phone_key, created_at);

-- tag ties a staff session to the PIN it was opened with, so changing the PIN signs every device out
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('customer', 'staff')),
  phone TEXT,
  tag TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  staff_id INTEGER,
  staff_name TEXT
);

-- a browser that has signed in to the staff page with the current PIN
CREATE TABLE IF NOT EXISTS devices (
  token_hash TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS throttle (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  strikes INTEGER NOT NULL DEFAULT 0
);

-- who did what, by row id only: no phone or vehicle numbers are written here
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);

-- staff accounts: a name and a keyed hash of that person's PIN. The owner's PIN is a server setting, not a row.
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);

-- tyres on the shelf, by size. Sales take from it, voided sales give back, the owner counts.
CREATE TABLE IF NOT EXISTS stock (
  size_key TEXT PRIMARY KEY,
  size TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  min_qty INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  size_key TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('sale', 'void', 'count')),
  sale_id INTEGER,
  actor TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moves_by_size ON stock_moves (size_key, id);

-- cookie-less counts: how many times a named thing happened on a given day, and nothing else
CREATE TABLE IF NOT EXISTS stats (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
`;

// an older database gets the columns this version adds; tables are created above with IF NOT EXISTS
function migrate(raw, from) {
  const has = (table, col) => raw.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (from < 2) {
    if (!has('sales', 'entered_by')) raw.exec('ALTER TABLE sales ADD COLUMN entered_by TEXT');
    if (!has('visits', 'entered_by')) raw.exec('ALTER TABLE visits ADD COLUMN entered_by TEXT');
    if (!has('sessions', 'staff_id')) raw.exec('ALTER TABLE sessions ADD COLUMN staff_id INTEGER');
    if (!has('sessions', 'staff_name')) raw.exec('ALTER TABLE sessions ADD COLUMN staff_name TEXT');
    // staff sessions from before accounts existed carry no name: everyone signs in again
    raw.exec("DELETE FROM sessions WHERE kind = 'staff'");
  }
}

function openDb(cfg, now = Date.now()) {
  const file = cfg.mode === 'demo' ? ':memory:' : path.join(cfg.dataDir, 'passport.sqlite');
  if (file !== ':memory:') fs.mkdirSync(cfg.dataDir, { recursive: true });
  const raw = new DatabaseSync(file);
  // a database written by a newer server is left exactly as it is
  const hasMeta = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const found = hasMeta ? raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() : null;
  if (found && Number(found.value) > SCHEMA_VERSION) { raw.close(); throw new Error(`database is at schema ${found.value}, newer than this server (${SCHEMA_VERSION}). Update the server.`); }
  // secure_delete: a deleted customer's rows are overwritten in the file, not just unlinked
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 4000');
  raw.exec(SCHEMA);

  const prepared = new Map();
  const db = {
    file,
    exec: sql => raw.exec(sql),
    // statements are prepared once and reused
    q(sql) {
      let st = prepared.get(sql);
      if (!st) prepared.set(sql, (st = raw.prepare(sql)));
      return st;
    },
    // deleted rows are overwritten in the main file (secure_delete); this empties the write-ahead log as well
    checkpoint() { if (file !== ':memory:') raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); },
    close() { prepared.clear(); raw.close(); },
  };

  const row = db.q('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!row) {
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
    setMeta(db, 'created_at', String(now));
  } else if (Number(row.value) < SCHEMA_VERSION) {
    migrate(raw, Number(row.value));
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  }
  return db;
}

const getMeta = (db, key) => { const r = db.q('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; };
const setMeta = (db, key, value) => db.q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// node:sqlite has no transaction helper; this is the one place that begins and ends them
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const audit = (db, now, actor, action, detail) =>
  db.q('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)').run(now, actor, action, detail ? JSON.stringify(detail) : null);

/* Nothing is kept without a reason: expired codes, sessions and counters go, invitations nobody took up go
   after a year, breakdown locations after a week, and a customer who has not visited for the number of years
   set in config/passport.json is deleted. */
function sweep(db, cfg, now) {
  const years = cfg.settings.privacy.deleteAfterInactiveYears;
  const cutoffMs = now - years * 365.25 * DAY_MS;
  const cutoffDay = new Date(cutoffMs + cfg.settings.shop.utcOffsetMinutes * 60e3).toISOString().slice(0, 10);
  return tx(db, () => {
    db.q('DELETE FROM otp_codes WHERE expires_at < ?').run(now - DAY_MS);
    db.q('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.q('DELETE FROM devices WHERE expires_at < ?').run(now);
    db.q('DELETE FROM throttle WHERE window_start < ? AND locked_until < ?').run(now - 8 * DAY_MS, now);
    db.q('DELETE FROM referrals WHERE converted_at IS NULL AND created_at < ?').run(now - 365 * DAY_MS);
    db.q('DELETE FROM breakdowns WHERE created_at < ?').run(now - 7 * DAY_MS);
    db.q('DELETE FROM audit WHERE at < ?').run(now - 365 * DAY_MS);
    // idle means no visit for that long AND nothing typed in for that long, so an old record entered today is kept
    const idle = db.q(`SELECT c.id, c.phone FROM customers c LEFT JOIN visits v ON v.customer_id = c.id
                       GROUP BY c.id HAVING c.created_at < ? AND (MAX(v.visited_on) IS NULL OR MAX(v.visited_on) < ?)
                                        AND (MAX(v.created_at) IS NULL OR MAX(v.created_at) < ?)`).all(cutoffMs, cutoffDay, cutoffMs);
    for (const c of idle) {
      db.q('DELETE FROM customers WHERE id = ?').run(c.id);
      db.q('DELETE FROM referrals WHERE friend_phone = ?').run(c.phone);
      db.q('DELETE FROM sessions WHERE phone = ?').run(c.phone);
    }
    if (idle.length) audit(db, now, 'system', 'customer.expire', { count: idle.length });
    return { expired: idle.length };
  });
}

// one copy a day beside the live file, seven kept. A deleted customer therefore leaves the backups within a week.
function backup(db, cfg, now) {
  if (db.file === ':memory:') return null;
  const dir = path.join(cfg.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const name = `passport-${new Date(now).toISOString().slice(0, 10)}.sqlite`;
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    setMeta(db, 'backup_at', String(now));
  }
  const old = fs.readdirSync(dir).filter(f => /^passport-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -7);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return target;
}

module.exports = { openDb, getMeta, setMeta, tx, audit, sweep, backup, SCHEMA_VERSION, DAY_MS };
