'use strict';

/* Tyre stock by size. The owner counts what is on the shelf; every sale registered at the desk takes its tyres
   off that count and every voided sale puts them back, so the count and the sales book agree without anyone
   typing twice. Sizes are matched on their core (185/65 R15 and 185/65R15 are one size). */

const { tx, audit } = require('./db');
const { Invalid } = require('./validate');
const est = require('./estimate');

// a problem with what the owner typed: answered like any other invalid field
class StockProblem extends Invalid {}

const keyOf = size => est.coreSize(String(size)).toUpperCase().replace(/\s+/g, '');
const DAY_MS = 86400e3;

const view = r => ({ size: r.size, key: r.size_key, qty: r.qty, minQty: r.min_qty, low: r.qty <= r.min_qty, updatedAt: r.updated_at });

// the stock list, with what each size sold in the last thirty days beside it
function list(db, cfg, now) {
  const rows = db.q('SELECT * FROM stock ORDER BY size_key').all().map(view);
  const since = est.addDays(est.today(now, cfg.settings.shop.utcOffsetMinutes), -30);
  const sold = new Map();
  for (const s of db.q('SELECT size, SUM(qty) AS q FROM sales WHERE fitted_on >= ? GROUP BY size').all(since)) {
    const k = keyOf(s.size);
    sold.set(k, (sold.get(k) || 0) + s.q);
  }
  for (const r of rows) r.sold30 = sold.get(r.key) || 0;
  // sizes that sold but are not counted yet are offered to the owner to add
  const untracked = [...sold].filter(([k]) => !rows.some(r => r.key === k)).map(([k, q]) => ({ key: k, sold30: q })).sort((a, b) => b.sold30 - a.sold30).slice(0, 12);
  return { rows, untracked, lowCount: rows.filter(r => r.low).length };
}

function count(db, { size, qty, minQty }, actor, now) {
  if (typeof size !== 'string' || !/^\d[0-9A-Z ./\-]{2,19}$/i.test(size.trim())) throw new StockProblem('size', 'Enter the tyre size as on the sidewall, for example 185/65 R15.');
  if (!Number.isInteger(qty) || qty < 0 || qty > 100000) throw new StockProblem('qty', 'Enter the count as a whole number.');
  if (minQty != null && (!Number.isInteger(minQty) || minQty < 0 || minQty > 100000)) throw new StockProblem('minQty', 'Enter the minimum as a whole number.');
  const written = size.trim().toUpperCase().replace(/\s+/g, ' ');
  const key = keyOf(written);
  return tx(db, () => {
    if (!db.q('SELECT 1 FROM stock WHERE size_key = ?').get(key) && db.q('SELECT COUNT(*) AS c FROM stock').get().c >= 2000) throw new StockProblem('size', 'Two thousand sizes is the most this list keeps.');
    const before = db.q('SELECT qty, min_qty FROM stock WHERE size_key = ?').get(key);
    const min = minQty == null ? (before ? before.min_qty : 0) : minQty;
    db.q(`INSERT INTO stock (size_key, size, qty, min_qty, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(size_key) DO UPDATE SET size = excluded.size, qty = excluded.qty, min_qty = excluded.min_qty, updated_at = excluded.updated_at`).run(key, written, qty, min, now);
    const delta = qty - (before ? before.qty : 0);
    if (delta !== 0 || !before) db.q("INSERT INTO stock_moves (size_key, delta, reason, sale_id, actor, at) VALUES (?, ?, 'count', NULL, ?, ?)").run(key, delta, actor, now);
    audit(db, now, actor, 'stock.count', { size: key, qty });
    return view(db.q('SELECT * FROM stock WHERE size_key = ?').get(key));
  });
}

function remove(db, size, actor, now) {
  const key = keyOf(size);
  return tx(db, () => {
    const gone = db.q('DELETE FROM stock WHERE size_key = ?').run(key).changes;
    if (!gone) throw new StockProblem('size', 'That size is not on the list.');
    audit(db, now, actor, 'stock.remove', { size: key });
    return { ok: true };
  });
}

// called in a transaction right after the sale is saved: a counted size goes down by what was fitted. An uncounted size is left alone.
function onSale(db, sale, actor, now) {
  const key = keyOf(sale.size);
  const row = db.q('SELECT * FROM stock WHERE size_key = ?').get(key);
  if (!row) return null;
  db.q('UPDATE stock SET qty = qty - ?, updated_at = ? WHERE size_key = ?').run(sale.qty, now, key);
  db.q("INSERT INTO stock_moves (size_key, delta, reason, sale_id, actor, at) VALUES (?, ?, 'sale', ?, ?, ?)").run(key, -sale.qty, sale.id, actor, now);
  return view(db.q('SELECT * FROM stock WHERE size_key = ?').get(key));
}
function onVoid(db, sale, actor, now) {
  const key = keyOf(sale.size);
  const row = db.q('SELECT * FROM stock WHERE size_key = ?').get(key);
  // only a sale that took stock off gives it back, and not when the owner has counted the shelf since
  const taken = db.q("SELECT id FROM stock_moves WHERE sale_id = ? AND reason = 'sale'").get(sale.id);
  if (!row || !taken) return null;
  if (db.q("SELECT 1 FROM stock_moves WHERE size_key = ? AND reason = 'count' AND id > ?").get(key, taken.id)) return view(row);
  db.q('UPDATE stock SET qty = qty + ?, updated_at = ? WHERE size_key = ?').run(sale.qty, now, key);
  db.q("INSERT INTO stock_moves (size_key, delta, reason, sale_id, actor, at) VALUES (?, ?, 'void', ?, ?, ?)").run(key, sale.qty, sale.id, actor, now);
  return view(db.q('SELECT * FROM stock WHERE size_key = ?').get(key));
}

const low = db => db.q('SELECT * FROM stock WHERE qty <= min_qty ORDER BY (qty - min_qty), size_key').all().map(view);
const moves = (db, key, limit = 30) => db.q('SELECT * FROM stock_moves WHERE size_key = ? ORDER BY id DESC LIMIT ?').all(key, limit)
  .map(m => ({ delta: m.delta, reason: m.reason, saleId: m.sale_id, by: m.actor, at: m.at }));
const sweepMoves = (db, now) => db.q('DELETE FROM stock_moves WHERE at < ?').run(now - 400 * DAY_MS).changes;

module.exports = { keyOf, list, count, remove, onSale, onVoid, low, moves, sweepMoves, StockProblem };
