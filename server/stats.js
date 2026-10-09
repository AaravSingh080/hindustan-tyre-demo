'use strict';

/* Counting without cookies. A page sends the name of a thing that happened (a step of Find my tyres, a chat
   opened); the server adds one to that name's count for today and keeps nothing else: no address, no device,
   no identifier, no path through the site. The counts are what the owner sees. */

const { tx } = require('./db');
const est = require('./estimate');

// every count a page may send. A name that is not here is refused, so nobody can fill the table with made-up ones.
const KEYS = new Set(['page.home', 'page.tyres', 'page.passport', 'page.compare', 'tyres.step.2', 'tyres.step.3', 'tyres.step.4', 'tyres.found', 'tyres.go', 'tyres.help', 'finder.vehicle', 'finder.search', 'chat.open', 'chat.ask', 'chat.quick']);
const DAY_MS = 86400e3;

const okKey = k => typeof k === 'string' && KEYS.has(k);

function bump(db, day, key) {
  db.q('INSERT INTO stats (day, key, n) VALUES (?, ?, 1) ON CONFLICT(day, key) DO UPDATE SET n = n + 1').run(day, key);
}

// the counts for the last `days` days, by day and in total
function summary(db, cfg, now, days) {
  const today = est.today(now, cfg.settings.shop.utcOffsetMinutes);
  const since = est.addDays(today, -(days - 1));
  const rows = db.q('SELECT day, key, n FROM stats WHERE day >= ? AND day <= ? ORDER BY day, key').all(since, today);
  const totals = {};
  for (const r of rows) totals[r.key] = (totals[r.key] || 0) + r.n;
  return { since, today, days, rows, totals };
}

const sweep = (db, cfg, now) => db.q('DELETE FROM stats WHERE day < ?').run(est.addDays(est.today(now, cfg.settings.shop.utcOffsetMinutes), -400)).changes;

// demo mode: a fortnight of made-up counts so the owner's page has something to show. Never runs on a live site.
function seedDemo(db, cfg, now) {
  const today = est.today(now, cfg.settings.shop.utcOffsetMinutes);
  const shape = { 'page.home': 60, 'page.tyres': 28, 'tyres.step.2': 22, 'tyres.step.3': 16, 'tyres.found': 12, 'tyres.go': 7, 'tyres.help': 3, 'finder.vehicle': 9, 'finder.search': 5, 'page.passport': 11, 'chat.open': 14, 'chat.ask': 10, 'chat.quick': 6 };
  tx(db, () => {
    for (let d = 13; d >= 0; d--) {
      const day = est.addDays(today, -d);
      // a weekly rhythm, quieter on Sundays and lower at the start of the fortnight, with no randomness
      const dow = new Date(day + 'T00:00:00Z').getUTCDay();
      const f = (dow === 0 ? 0.55 : 1) * (0.7 + 0.3 * (13 - d) / 13);
      for (const [k, n] of Object.entries(shape)) {
        const v = Math.max(0, Math.round(n * f) - (d % 3));
        if (v) db.q('INSERT INTO stats (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = excluded.n').run(day, k, v);
      }
    }
  });
}

module.exports = { okKey, bump, summary, sweep, seedDemo, KEYS, DAY_MS };
