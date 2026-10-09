'use strict';

/* When will these tyres need replacing, and when is the next rotation or alignment check due.
   Pure functions: everything comes in as arguments, so the numbers can be tested without a database. */

const DAY = 86400e3;
const MONTH = 30.4375;   // days

const toDay = s => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
const fromDay = n => new Date(Math.round(n) * DAY).toISOString().slice(0, 10);
const today = (nowMs, utcOffsetMinutes) => new Date(nowMs + utcOffsetMinutes * 60e3).toISOString().slice(0, 10);
const addDays = (s, n) => fromDay(toDay(s) + n);
function addMonths(s, n) {
  const y = +s.slice(0, 4), m = +s.slice(5, 7) - 1 + n, d = +s.slice(8, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = v => Math.round(v * 10) / 10;

// "185/65 R15 88H", "185/65/15", "90/100-10 53J", "10.00-20 16PR": the size itself, without load index or ply rating
function coreSize(size) {
  const m = /^(\d{1,3}(?:\.\d{1,2})?(?:\/\d{2,3})?)\s*(ZR|R|B|-|\/)\s*(\d{1,2}(?:\.\d)?)(?![\d.])/i.exec(size.trim());
  if (!m) return size.replace(/\s+/g, '');
  const sep = m[2].toUpperCase();
  return m[1] + (sep === 'ZR' || sep === '/' ? 'R' : sep) + m[3];
}

// the first profile whose pattern matches the size; the last one matches everything
function profileFor(size, tyres) {
  const core = coreSize(size);
  for (const p of tyres.profiles) if (p.sizeMatch === '' || new RegExp(p.sizeMatch, 'i').test(core)) return p;
  return tyres.profiles[tyres.profiles.length - 1];
}

/* sale:   { fitted_on, odometer_km, size, new_tread_mm }
   visits: later visits for this set of tyres, each { kind, visited_on, odometer_km, tread_mm }
   Fitting day is reading one (a new tyre at the fitting odometer). Once there is a tread reading far enough
   down the road to mean something, wear is fitted to the readings. Until then the estimate rests on typical
   tyre life and monthly distance, with the customer's own monthly distance as soon as the odometer shows it. */
function estimateSale(sale, visits, tyres, todayStr) {
  const profile = profileFor(sale.size, tyres);
  const fit = toDay(sale.fitted_on), now = toDay(todayStr);
  const newTread = sale.new_tread_mm == null ? profile.newTreadMm : sale.new_tread_mm;
  const replaceAt = profile.replaceAtMm;
  const typicalWear = (profile.newTreadMm - replaceAt) / profile.typicalLifeKm;   // mm per km

  const rs = visits
    .filter(v => v.kind !== 'purchase' && (v.odometer_km != null || v.tread_mm != null))
    // a sale brought in from the old book may have no starting reading (stored as 0): distance is then unknown
    .map(v => ({ id: v.id || 0, day: toDay(v.visited_on), km: v.odometer_km == null || !(sale.odometer_km > 0) ? null : v.odometer_km - sale.odometer_km, tread: v.tread_mm }))
    .filter(r => r.day >= fit && (r.km == null || r.km >= 0))
    // by day, then in the order they were entered, so a corrected reading on the same day is the one that counts
    .sort((a, b) => a.day - b.day || a.id - b.id);

  // distance per month is measured once the odometer has moved over at least two weeks
  const odo = rs.filter(r => r.km != null && r.km > 0 && r.day - fit >= 14).pop() || null;
  const measured = odo ? clamp(odo.km / ((odo.day - fit) / MONTH), 50, 30000) : null;
  const kmPerMonth = measured == null ? profile.typicalMonthlyKm : measured;
  const kmAt = r => (r.km != null ? r.km : ((r.day - fit) / MONTH) * kmPerMonth);

  const pts = rs.filter(r => r.tread != null).map(r => ({ day: r.day, km: kmAt(r), tread: r.tread }));
  const last = pts.length ? pts[pts.length - 1] : null;

  let basis = 'typical', wear = typicalWear, dueDay;
  if (last && last.tread <= replaceAt) {
    // measured at or below replacement depth: due on the day it was measured
    dueDay = last.day;
    basis = 'readings';
  } else if (last && last.km >= tyres.minKmForReadings) {
    // least squares through the fitting day and every reading since
    const all = [{ km: 0, tread: newTread }, ...pts];
    const mk = all.reduce((a, p) => a + p.km, 0) / all.length, mt = all.reduce((a, p) => a + p.tread, 0) / all.length;
    const sxx = all.reduce((a, p) => a + (p.km - mk) ** 2, 0), sxy = all.reduce((a, p) => a + (p.km - mk) * (p.tread - mt), 0);
    const slope = sxx > 0 ? sxy / sxx : 0;
    // a slip of the gauge must not promise 200,000 km or condemn a tyre in a month. Readings that show no
    // wear at all count as the slowest wear allowed, so a lower reading can never push the date later.
    wear = clamp(Math.max(0, -slope), typicalWear / 2.5, typicalWear * 2.5);
    dueDay = last.day + (((last.tread - replaceAt) / wear) / kmPerMonth) * MONTH;
    basis = 'readings';
  } else {
    dueDay = odo ? odo.day + (Math.max(0, profile.typicalLifeKm - odo.km) / kmPerMonth) * MONTH : fit + (profile.typicalLifeKm / kmPerMonth) * MONTH;
    // a reading taken too soon after fitting to show a wear rate still counts for what it measured:
    // the tyre cannot have more tread than the gauge found
    if (last) dueDay = Math.min(dueDay, last.day + (((last.tread - replaceAt) / typicalWear) / kmPerMonth) * MONTH);
  }

  // rubber ages even when the tread is fine
  let reason = 'wear';
  const ageDay = fit + Math.round(tyres.maxAgeYears * 365.25);
  if (ageDay < dueDay) { dueDay = ageDay; reason = 'age'; }
  dueDay = Math.round(dueDay);

  let treadNow;
  if (basis === 'readings') treadNow = last.tread - wear * ((now - last.day) / MONTH) * kmPerMonth;
  else {
    treadNow = newTread - typicalWear * (odo ? odo.km + ((now - odo.day) / MONTH) * kmPerMonth : ((now - fit) / MONTH) * kmPerMonth);
    if (last) treadNow = Math.min(treadNow, last.tread - typicalWear * ((now - last.day) / MONTH) * kmPerMonth);
  }

  return {
    basis,                                  // 'readings' or 'typical'
    reason,                                 // 'wear' or 'age'
    profile: profile.key,
    dueOn: fromDay(dueDay),
    daysLeft: dueDay - now,
    kmLeft: Math.max(0, Math.round((((dueDay - now) / MONTH) * kmPerMonth) / 100) * 100),
    kmPerMonth: Math.round(kmPerMonth / 10) * 10,
    kmPerMonthMeasured: measured != null,
    treadNowMm: round1(clamp(treadNow, 0, newTread)),
    newTreadMm: newTread,
    replaceAtMm: replaceAt,
    legalMinMm: profile.legalMinMm,
    atLimit: !!last && last.tread <= profile.legalMinMm,   // only ever from a real measurement
    readings: basis === 'readings' ? pts.length + 1 : 1,
    lastReadingOn: last ? fromDay(last.day) : null,
    lastReadingMm: last ? last.tread : null,
    typicalLifeKm: profile.typicalLifeKm,
  };
}

/* Each service is due after everyKm or everyMonths since it was last done on this vehicle, whichever comes
   first. Fitting day counts as the starting point. visits: every visit for the vehicle, services parsed.
   A service applies only to the tyre kinds listed in its `for`. */
function servicesDue(sale, visits, reminders, profileKey, kmPerMonth, todayStr) {
  const fit = toDay(sale.fitted_on), now = toDay(todayStr);
  return reminders.services.filter(svc => !svc.for || svc.for.includes(profileKey)).map(svc => {
    const done = visits.filter(v => v.services.includes(svc.key)).map(v => toDay(v.visited_on)).filter(d => d >= fit);
    const from = done.length ? Math.max(...done) : fit;
    const byTime = svc.everyMonths * MONTH, byKm = (svc.everyKm / kmPerMonth) * MONTH;
    const dueDay = Math.round(from + Math.min(byTime, byKm));
    return {
      key: svc.key,
      name: svc.name,
      lastDoneOn: done.length ? fromDay(from) : null,
      dueOn: fromDay(dueDay),
      daysLeft: dueDay - now,
      by: byKm < byTime ? 'distance' : 'time',
      everyKm: svc.everyKm,
      everyMonths: svc.everyMonths,
    };
  });
}

// great-circle distance in km
function distanceKm(aLat, aLng, bLat, bLng) {
  const rad = d => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function nearestShop(shops, lat, lng) {
  if (lat == null || lng == null) return { shop: shops[0], km: null };
  let best = null;
  for (const shop of shops) {
    const km = distanceKm(lat, lng, shop.lat, shop.lng);
    if (!best || km < best.km) best = { shop, km };
  }
  return best;
}

module.exports = { DAY, MONTH, toDay, fromDay, today, addDays, addMonths, coreSize, profileFor, estimateSale, servicesDue, distanceKm, nearestShop };
