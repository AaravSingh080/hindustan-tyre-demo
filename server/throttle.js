'use strict';

/* Counters and lock-outs, kept in the database so a restart does not hand out a fresh allowance. */

const get = (db, key) => db.q('SELECT count, window_start, locked_until, strikes FROM throttle WHERE key = ?').get(key);

// rules: [{ key, limit, windowMs }]. Every rule is checked before any is counted, so a refusal costs nothing.
function allow(db, rules, now) {
  let wait = 0;
  const rows = rules.map(r => {
    const row = get(db, r.key);
    const live = row && now - row.window_start < r.windowMs;
    if (live && row.count >= r.limit) wait = Math.max(wait, row.window_start + r.windowMs - now);
    return live;
  });
  if (wait) return { ok: false, retryAfterMs: wait };
  rules.forEach((r, i) => {
    if (rows[i]) db.q('UPDATE throttle SET count = count + 1 WHERE key = ?').run(r.key);
    else db.q('INSERT INTO throttle (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start').run(r.key, now);
  });
  return { ok: true, retryAfterMs: 0 };
}

// hands back an allowance that was counted for something that then did not happen
function refund(db, rules) {
  for (const r of rules) db.q('UPDATE throttle SET count = MAX(0, count - 1) WHERE key = ?').run(r.key);
}

// looks without counting: how long until this rule has room again (0 when it has room now)
function waitFor(db, r, now) {
  const row = get(db, r.key);
  return row && now - row.window_start < r.windowMs && row.count >= r.limit ? row.window_start + r.windowMs - now : 0;
}

const lockedFor = (db, key, now) => {
  const row = get(db, key);
  return row && row.locked_until > now ? row.locked_until - now : 0;
};

// one wrong try. After `tries` inside the window the key is locked; each further lock-out lasts twice as long.
function strike(db, key, { tries, windowMs, lockMs, maxLockMs }, now) {
  const row = get(db, key);
  // a try made while the key is locked changes nothing: it must never shorten or lift the lock-out
  if (row && row.locked_until > now) return { lockedMs: row.locked_until - now, left: 0 };
  const live = row && now - row.window_start < windowMs;
  let count = live ? row.count + 1 : 1;
  let start = live ? row.window_start : now;
  let strikes = row ? row.strikes : 0;
  let lockedUntil = 0;
  if (count >= tries) {
    strikes += 1;
    lockedUntil = now + Math.min(lockMs * 2 ** (strikes - 1), maxLockMs);
    count = 0;
    start = now;
  }
  db.q(`INSERT INTO throttle (key, count, window_start, locked_until, strikes) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, locked_until = excluded.locked_until, strikes = excluded.strikes`)
    .run(key, count, start, lockedUntil, strikes);
  return { lockedMs: lockedUntil ? lockedUntil - now : 0, left: lockedUntil ? 0 : tries - count };
}

const clear = (db, key) => db.q('DELETE FROM throttle WHERE key = ?').run(key);

module.exports = { allow, refund, waitFor, lockedFor, strike, clear };
