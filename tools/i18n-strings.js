'use strict';

/* Lists every English string a customer can read on the Find my tyres and Tyre passport pages: text in the
   HTML, attributes that are read aloud or shown (aria-label, placeholder, alt, title), the string literals in
   the scripts that build those pages, and the service names from config/passport.json. The Hindi and Punjabi
   dictionaries in js/lang/ must cover all of them.

     node tools/i18n-strings.js            prints the list
     node tools/i18n-strings.js --missing  prints what js/lang/hi.js and js/lang/pa.js still lack

   After changing words on those pages, run it with --missing and add the translations. A display heading
   split around <em> ("Found <em>it.</em>") is listed as one sentence; its translation marks the emphasised
   part between *stars*. */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = [
  ['tyres/index.html', 'html'], ['js/tyres.js', 'js'],
  ['passport/index.html', 'html'], ['js/passport.js', 'js'],
  ['js/app-kit.js', 'js'],
  ['config/passport.json', 'settings'],
];

function worth(s) {
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 2) return null;
  if (/^[\d\s.,:/+%-]+$/.test(s)) return null;                                   // numbers and punctuation
  if (/^[:>]|[<>]/.test(s)) return null;                                           // selectors and markup
  if (/^[a-z0-9_-]+$/.test(s) && !/^(ok|yes|no|on|off)$/i.test(s)) return null;  // identifiers and keys
  if (/^(https?:|\/|#|tel:|mailto:|\.|wa\.me)/.test(s)) return null;              // addresses
  if (/^[A-Z]{2}\d{2}[A-Z]{2}\d{4}$/.test(s)) return null;                         // plates
  if (!/[A-Za-z]{2}/.test(s)) return null;
  return s;
}

const strip = html => html.replace(/<[^>]+>/g, '');
function fromHtml(src, add) {
  src = src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
  // display headings as whole sentences
  src = src.replace(/<(h[1-6])\b[^>]*class="[^"]*\bdisplay\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g, (m, tag, inner) => { add(strip(inner)); return ''; });
  for (const m of src.matchAll(/>([^<>]+)</g)) add(m[1]);
  for (const m of src.matchAll(/\b(aria-label|placeholder|alt|title|content)="([^"]+)"/g)) {
    if (m[1] === 'content' && !/description/.test(src.slice(Math.max(0, m.index - 80), m.index))) continue;
    add(m[2]);
  }
}

/* a small tokenizer: strings and template literals out, comments and regular expressions skipped.
   Inside a template, each ${...} becomes a numbered placeholder. */
function literals(src) {
  const out = [];
  let i = 0, prev = '';
  const n = src.length;
  const regexMayStart = () => prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|in|of)$/.test(prev);
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== ch && src[j] !== '\n') { if (src[j] === '\\') { s += unescape(src[j + 1]); j += 2; } else s += src[j++]; }
      out.push(s); i = j + 1; prev = ch; continue;
    }
    if (ch === '`') {
      let j = i + 1, s = '', k = 0;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { s += unescape(src[j + 1]); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          // skip the expression, minding nested braces and strings inside it
          let depth = 1; j += 2;
          while (j < n && depth) {
            const c = src[j];
            if (c === '{') depth++;
            else if (c === '}') depth--;
            else if (c === "'" || c === '"' || c === '`') { const q = c; j++; while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; } }
            j++;
          }
          s += `{${k++}}`;
          continue;
        }
        s += src[j++];
      }
      out.push(s); i = j + 1; prev = '`'; continue;
    }
    if (ch === '/' && regexMayStart()) {
      let j = i + 1, cls = false;
      while (j < n && (cls || src[j] !== '/') && src[j] !== '\n') { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      i = j + 1; prev = '/'; continue;
    }
    if (!/\s/.test(ch)) prev = /[A-Za-z_$]/.test(ch) ? (/[A-Za-z_$]$/.test(prev) ? prev + ch : ch) : ch;
    i++;
  }
  return out;
}
const unescape = c => ({ n: '\n', t: '\t', "'": "'", '"': '"', '`': '`', '\\': '\\', $: '$', '{': '{' }[c] || c);

function fromJs(src, add) {
  for (let s of literals(src)) {
    s = s.replace(/\\u2019/g, '’');
    if (/\{\d\}/.test(s) && !/[A-Za-z]{3,}/.test(s.replace(/\{\d\}/g, ''))) continue;   // a template that is all placeholders
    if (/^[.#\[]|^\/api|^[a-z-]+$|^[a-z]+(\.[a-z-]+)+$|^data-|^aria-|^on[a-z]+$|^(GET|POST)$|^\d/.test(s)) continue;
    if (/^[A-Za-z]+:[A-Za-z]+/.test(s)) continue;
    if (!/\s|[.!?]/.test(s) && !/^[A-Z][a-z]+$/.test(s)) continue;   // single tokens are mostly code, except capitalised words
    add(s);
  }
}
function fromSettings(src, add) {
  const s = JSON.parse(src);
  for (const sv of (s.rewards && s.rewards.services) || []) add(sv.name);
  for (const sv of (s.reminders && s.reminders.services) || []) add(sv.name);
}

function extract(root = ROOT) {
  const out = new Map();
  for (const [file, kind] of SOURCES) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const add = s => { const w = worth(s); if (w && !out.has(w)) out.set(w, file); };
    (kind === 'html' ? fromHtml : kind === 'js' ? fromJs : fromSettings)(src, add);
  }
  return [...out].map(([s, where]) => ({ s, where }));
}

// the dictionary a lang script defines, read without a browser
function dictionary(code, root = ROOT) {
  const file = path.join(root, 'js', 'lang', code + '.js');
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8');
  const window = {};
  new Function('window', src)(window);
  return window.HTA_LANG && window.HTA_LANG[code] ? window.HTA_LANG[code] : null;
}

if (require.main === module) {
  const list = extract();
  if (process.argv.includes('--missing')) {
    for (const code of ['hi', 'pa']) {
      const d = dictionary(code) || {};
      const missing = list.filter(x => !d[x.s]);
      console.log(`${code}: ${missing.length} of ${list.length} missing`);
      for (const x of missing) console.log('  ', JSON.stringify(x.s), '  (' + x.where + ')');
    }
  } else {
    for (const x of list) console.log(x.where.padEnd(22), JSON.stringify(x.s));
    console.log(list.length, 'strings');
  }
}

module.exports = { extract, dictionary, literals, SOURCES };
