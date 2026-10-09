'use strict';

/* The numbers on the owner's page: what was sold, who came in, what is due, what staff did. Everything here is
   a count or a sum over the shop's own book; no customer is named. */

const est = require('./estimate');
const stock = require('./stock');

function overview(db, cfg, now) {
  const today = est.today(now, cfg.settings.shop.utcOffsetMinutes);
  const spans = { today: today, week: est.addDays(today, -6), month: est.addDays(today, -29), year: est.addDays(today, -364) };
  // the moment a shop day began, for tables that keep moments rather than days
  const startMs = day => est.toDay(day) * 86400e3 - cfg.settings.shop.utcOffsetMinutes * 60e3;
  const period = since => ({
    sales: db.q('SELECT COUNT(*) AS c, COALESCE(SUM(qty), 0) AS tyres, COALESCE(SUM(amount_paise), 0) AS paise FROM sales WHERE fitted_on >= ? AND fitted_on <= ?').get(since, today),
    services: db.q("SELECT COUNT(*) AS c FROM visits WHERE kind = 'service' AND visited_on >= ? AND visited_on <= ?").get(since, today).c,
    newCustomers: db.q('SELECT COUNT(*) AS c FROM (SELECT customer_id, MIN(fitted_on) AS first FROM sales GROUP BY customer_id) WHERE first >= ? AND first <= ?').get(since, today).c,
    remindersSent: db.q("SELECT COUNT(*) AS c FROM reminder_log WHERE status = 'marked_sent' AND at >= ?").get(startMs(since)).c,
    breakdowns: db.q('SELECT COUNT(*) AS c FROM breakdowns WHERE created_at >= ?').get(startMs(since)).c,
  });
  // the lists for one period: sizes and tyres sold, and who entered what
  const lists = since => {
    const topSizes = db.q('SELECT size, SUM(qty) AS q, COUNT(*) AS n FROM sales WHERE fitted_on >= ? AND fitted_on <= ? GROUP BY size ORDER BY q DESC LIMIT 8').all(since, today).map(r => ({ size: r.size, tyres: r.q, sales: r.n }));
    const topTyres = db.q('SELECT tyre, SUM(qty) AS q FROM sales WHERE fitted_on >= ? AND fitted_on <= ? GROUP BY tyre ORDER BY q DESC LIMIT 8').all(since, today).map(r => ({ tyre: r.tyre, tyres: r.q }));
    const byStaff = db.q(`SELECT COALESCE(entered_by, 'staff') AS who, COUNT(*) AS sales, COALESCE(SUM(qty), 0) AS tyres FROM sales WHERE fitted_on >= ? AND fitted_on <= ? GROUP BY who ORDER BY sales DESC`).all(since, today)
      .map(r => ({ who: r.who, sales: r.sales, tyres: r.tyres, services: 0 }));
    for (const v of db.q(`SELECT COALESCE(entered_by, 'staff') AS who, COUNT(*) AS visits FROM visits WHERE kind = 'service' AND visited_on >= ? AND visited_on <= ? GROUP BY who`).all(since, today)) {
      const row = byStaff.find(r => r.who === v.who);
      if (row) row.services = v.visits; else byStaff.push({ who: v.who, sales: 0, tyres: 0, services: v.visits });
    }
    return { topSizes, topTyres, byStaff };
  };
  const periods = {};
  for (const [name, since] of Object.entries(spans)) {
    const p = period(since);
    periods[name] = { since, sales: p.sales.c, tyres: p.sales.tyres, rupees: Math.round(p.sales.paise / 100), services: p.services, newCustomers: p.newCustomers, remindersSent: p.remindersSent, breakdowns: p.breakdowns, ...lists(since) };
  }
  const customers = db.q('SELECT COUNT(*) AS c, SUM(reminders_ok) AS ok FROM customers').get();
  const vehicles = db.q('SELECT COUNT(*) AS c FROM vehicles').get().c;
  const unseenBreakdowns = db.q('SELECT COUNT(*) AS c FROM breakdowns WHERE seen_at IS NULL').get().c;
  const lowStock = stock.low(db);
  const recent = db.q('SELECT at, actor, action FROM audit ORDER BY id DESC LIMIT 12').all();
  return {
    today,
    periods,
    customers: { total: customers.c, remindersOk: customers.ok || 0, vehicles },
    unseenBreakdowns,
    lowStock: lowStock.slice(0, 8),
    lowStockCount: lowStock.length,
    recent: recent.map(r => ({ at: r.at, actor: r.actor, action: r.action })),
  };
}

module.exports = { overview };
