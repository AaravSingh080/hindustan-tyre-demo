'use strict';

/* Every value that arrives from a phone or a staff tablet is checked here before anything else sees it.
   A checker returns the cleaned value or throws Invalid with a message a person can act on. */

class Invalid extends Error {
  constructor(field, message) { super(message); this.field = field; }
}

// control and invisible characters out, runs of space collapsed
const tidy = v => v.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();

const validDay = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
  return d.toISOString().slice(0, 10) === s;
};

const is = {
  // Indian mobile numbers only. In demo mode only made-up numbers starting 555 are taken (no real mobile starts
  // with 5), so a real person's number can never be typed into a demo; on a live site those are refused.
  phone: ({ demo = false } = {}) => v => {
    const bad = new Invalid('phone', demo ? 'This is a demo. Use a sample number that starts with 555, such as 55500 00199.' : 'Enter a 10 digit mobile number.');
    if (typeof v !== 'string' || v.length > 20) throw bad;
    let d = v.replace(/[\s\-().]/g, '');
    if (d.startsWith('+91')) d = d.slice(3);
    else if (/^91\d{10}$/.test(d)) d = d.slice(2);
    else if (/^0\d{10}$/.test(d)) d = d.slice(1);
    if (demo ? /^555\d{7}$/.test(d) : /^[6-9]\d{9}$/.test(d)) return '+91' + d;
    throw bad;
  },

  // kept loose on purpose: old plates, BH series, tractors and trolleys all turn up at a tyre shop
  regNo: field => v => {
    const bad = new Invalid(field, 'Enter the vehicle number as it is on the plate, for example PB10HT2005.');
    if (typeof v !== 'string' || v.length > 24) throw bad;
    const d = v.toUpperCase().replace(/[\s\-.]/g, '');
    if (!/^[A-Z0-9]{4,12}$/.test(d)) throw bad;
    return d;
  },

  // the last four characters of a vehicle number, asked for at sign-in
  plateTail: field => v => {
    const bad = new Invalid(field, 'Enter the last 4 characters of your vehicle number.');
    if (typeof v !== 'string' || v.length > 12) throw bad;
    const d = v.toUpperCase().replace(/[\s\-.]/g, '');
    if (!/^[A-Z0-9]{4}$/.test(d)) throw bad;
    return d;
  },

  // a random label the form makes up once, so sending the same form twice saves it once
  idem: field => v => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(v)) throw new Invalid(field, 'That request label is not valid.');
    return v;
  },

  // what staff type to find a customer: part of a vehicle number, or digits of a phone number
  lookup: field => v => {
    const bad = new Invalid(field, 'Type at least 3 characters of the vehicle number, or 4 digits of the phone number.');
    if (typeof v !== 'string' || v.length > 24) throw bad;
    const q = v.toUpperCase().replace(/[\s+\-.]/g, '');
    if (!/^[A-Z0-9]{3,14}$/.test(q)) throw bad;
    // a full number typed with its country code or the 0 some people dial first is searched as the number itself
    return /^91\d{10}$/.test(q) ? q.slice(2) : /^0\d{10}$/.test(q) ? q.slice(1) : q;
  },

  text: (field, min, max, what) => v => {
    if (typeof v !== 'string' || v.length > max * 4) throw new Invalid(field, `Enter ${what}.`);
    const t = tidy(v);
    if (t.length < min || t.length > max) throw new Invalid(field, `Enter ${what} (${min} to ${max} characters).`);
    if (/[<>]/.test(t)) throw new Invalid(field, `Remove the < and > characters from ${what}.`);
    return t;
  },

  size: field => v => {
    const bad = new Invalid(field, 'Enter the tyre size as on the sidewall, for example 185/65 R15.');
    if (typeof v !== 'string' || v.length > 40) throw bad;
    const t = tidy(v).toUpperCase();
    if (!/^\d[0-9A-Z ./\-]{2,19}$/.test(t)) throw bad;
    return t;
  },

  billNo: field => v => {
    if (typeof v !== 'string' || v.length > 60) throw new Invalid(field, 'Enter the bill number.');
    const t = tidy(v).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9/\- ]{0,29}$/.test(t)) throw new Invalid(field, 'A bill number can use letters, digits, / and - only.');
    return t;
  },

  int: (field, min, max, what) => v => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Invalid(field, `Enter ${what} as a whole number from ${min.toLocaleString('en-IN')} to ${max.toLocaleString('en-IN')}.`);
    return v;
  },

  // one decimal place is all a tread gauge gives
  mm: (field, min, max, what) => v => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Invalid(field, `Enter ${what} in millimetres, from ${min} to ${max}.`);
    return Math.round(v * 10) / 10;
  },

  // rupees in, paise out, so money is never stored as a fraction
  rupees: field => v => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7) throw new Invalid(field, 'Enter the bill amount in rupees.');
    return Math.round(v * 100);
  },

  bool: field => v => {
    if (typeof v !== 'boolean') throw new Invalid(field, 'This must be yes or no.');
    return v;
  },

  // a day in the shop's calendar, no later than today and no earlier than `backDays` ago
  day: (field, today, backDays, what) => v => {
    if (!validDay(v)) throw new Invalid(field, `Enter ${what} as a date.`);
    const earliest = new Date(Date.parse(today + 'T00:00:00Z') - backDays * 86400e3).toISOString().slice(0, 10);
    if (v > today) throw new Invalid(field, `${what[0].toUpperCase() + what.slice(1)} cannot be in the future.`);
    if (v < earliest) throw new Invalid(field, `${what[0].toUpperCase() + what.slice(1)} is too far back.`);
    return v;
  },

  code: v => {
    if (typeof v !== 'string' || !/^\d{6}$/.test(v.trim())) throw new Invalid('code', 'Enter the 6 digit code.');
    return v.trim();
  },

  pin: v => {
    if (typeof v !== 'string' || !/^\d{4,12}$/.test(v)) throw new Invalid('pin', 'Enter the staff PIN.');
    return v;
  },

  referralCode: field => v => {
    if (typeof v !== 'string' || v.length > 20) throw new Invalid(field, 'That referral code is not right.');
    const t = v.toUpperCase().replace(/[\s\-]/g, '');
    if (!/^[A-Z0-9]{8}$/.test(t)) throw new Invalid(field, 'A referral code has 8 letters and digits.');
    return t;
  },

  token: field => v => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) throw new Invalid(field, 'This link is not valid.');
    return v;
  },

  oneOf: (field, list) => v => {
    if (typeof v !== 'string' || !list.includes(v)) throw new Invalid(field, 'That choice is not available.');
    return v;
  },

  keys: (field, known, max) => v => {
    if (!Array.isArray(v) || v.length > max) throw new Invalid(field, 'Choose from the listed services.');
    const out = [];
    for (const k of v) {
      if (typeof k !== 'string' || !known.has(k)) throw new Invalid(field, 'Choose from the listed services.');
      if (!out.includes(k)) out.push(k);
    }
    return out;
  },

  coord: (field, limit) => v => {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limit) throw new Invalid(field, 'That location is not valid.');
    return Math.round(v * 1e5) / 1e5;   // about a metre; nothing finer is kept
  },

  metres: field => v => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e6) throw new Invalid(field, 'That location is not valid.');
    return Math.round(v);
  },
};

const need = (check, missing) => ({ required: true, check, missing });
const opt = check => ({ required: false, check });

// unknown fields are refused rather than ignored, so a typo in a client never passes silently
function shape(body, spec) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Invalid('', 'Send the details as a JSON object.');
  for (const k of Object.keys(body)) if (!Object.hasOwn(spec, k)) throw new Invalid(k.slice(0, 40), 'That field is not expected here.');
  const out = {};
  for (const [k, rule] of Object.entries(spec)) {
    const v = body[k];
    if (v === undefined || v === null || v === '') {
      if (rule.required) throw new Invalid(k, rule.missing || 'This is needed.');
      out[k] = null;
    } else out[k] = rule.check(v);
  }
  return out;
}

module.exports = { Invalid, is, need, opt, shape, tidy, validDay };
