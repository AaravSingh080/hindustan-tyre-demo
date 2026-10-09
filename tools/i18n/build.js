'use strict';

/* Builds js/lang/hi.js and js/lang/pa.js from the dictionaries in this folder.

     node tools/i18n/build.js

   hi.json and pa.json map every English string on the Find my tyres and Tyre passport pages to its translation
   (made by translators and reviewed); extra.json holds hand-made entries that take precedence (display headings
   with the emphasised part between *stars*, service names, sentences with {0} placeholders). The build refuses
   to write when a string is missing, a placeholder is lost, or a dash or markup slips in. To see what is missing
   after the pages change: node tools/i18n-strings.js --missing */

const fs = require('node:fs');
const path = require('node:path');
const { extract } = require('../i18n-strings');

const ROOT = path.resolve(__dirname, '..', '..');
const strings = extract(ROOT).map(x => x.s);
const extra = JSON.parse(fs.readFileSync(path.join(__dirname, 'extra.json'), 'utf8'));
const NAMES = { hi: 'Hindi', pa: 'Punjabi' };
let bad = 0;
for (const code of ['hi', 'pa']) {
  const dict = { ...JSON.parse(fs.readFileSync(path.join(__dirname, code + '.json'), 'utf8')), ...(extra[code] || {}) };
  const out = {}, problems = [];
  const ph = k => [...k.matchAll(/\{(\d)\}/g)].map(m => m[1]).sort().join(',');
  for (const s of strings) {
    const v = dict[s];
    if (typeof v !== 'string' || !v.trim()) { problems.push('missing: ' + s); continue; }
    if (ph(s) !== ph(v)) problems.push(`placeholders differ: ${s} -> ${v}`);
    if (/[\u2013\u2014<>]/.test(v)) problems.push('dash or markup: ' + v);
    out[s] = v.replace(/\s+/g, ' ').trim();
  }
  const unused = Object.keys(dict).filter(k => !strings.includes(k)).length;
  console.log(`${code}: ${Object.keys(out).length} of ${strings.length} strings, ${unused} entries no longer used, ${problems.length} problems`);
  for (const p of problems.slice(0, 20)) console.log('  ', p);
  if (problems.length) { bad++; continue; }
  fs.mkdirSync(path.join(ROOT, 'js', 'lang'), { recursive: true });
  const js = `/* ${NAMES[code]} for the Find my tyres and Tyre passport pages. Built by tools/i18n/build.js from tools/i18n/${code}.json and extra.json; English text is the key. */\nwindow.HTA_LANG = window.HTA_LANG || {};\nwindow.HTA_LANG.${code} = ${JSON.stringify(out, null, 1)};\n`;
  fs.writeFileSync(path.join(ROOT, 'js', 'lang', `${code}.js`), js);
}
process.exit(bad ? 1 : 0);
