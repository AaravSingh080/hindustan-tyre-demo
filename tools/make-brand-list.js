'use strict';

/* Compiles the tyre brand list that Find my tyres offers ("Which tyre brand?") from the live store's public
   product feed, and writes it into js/data.js as the line that starts with window.HTA_DATA.brandTypeTags.

     node tools/make-brand-list.js            reads the store, rewrites the line
     node tools/make-brand-list.js --print    reads the store, prints the line and changes nothing

   A brand is listed when its logo is in assets/img/brands and the store has tyres whose name starts with it.
   words: what the store's search is asked for (title:word), because the store's own brand tags are not on
   every product. types: the kinds of vehicle the store lists that brand for, by its type tags, in the order
   Find my tyres shows them. n: how many tyres the brand has, which puts the biggest ranges first.
   Run it again when the shop takes on a brand or drops one. */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://hindustantyreagencies.com';
// id (also the logo's file name), the name as it is shown, and the words of that name as the store writes it
const BRANDS = [
  ['apollo', 'Apollo', ['apollo']], ['bfgoodrich', 'BFGoodrich', ['goodrich']], ['bridgestone', 'Bridgestone', ['bridgestone']],
  ['ceat', 'CEAT', ['ceat']], ['continental', 'Continental', ['continental']], ['goodyear', 'Goodyear', ['good', 'year']],
  ['jktyre', 'JK Tyre', ['jk']], ['maxxis', 'Maxxis', ['maxxis']], ['michelin', 'Michelin', ['michelin']],
  ['pirelli', 'Pirelli', ['pirelli']], ['radar', 'Radar', ['radar']], ['yokohama', 'Yokohama', ['yokohama']],
];
// the store's own tag for each kind of vehicle, keyed the way js/tyres.js names them
const TYPE_TAGS = { car: 'Car Tyre', scooter: 'Scooter', motorcycle: 'Motor Cycle', tractor: 'Tractor tyre', truck: 'Truck', erickshaw: 'E riksha' };

async function products() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${BASE}/products.json?limit=250&page=${page}`, { headers: { 'user-agent': 'Mozilla/5.0 (brand list)' } });
    if (!res.ok) throw new Error(`the store answered ${res.status} for page ${page}`);
    const batch = (await res.json()).products || [];
    all.push(...batch);
    if (batch.length < 250) break;
  }
  return all;
}

(async () => {
  const tyres = (await products()).filter(p => p.product_type === 'Tyre');
  if (tyres.length < 100) throw new Error(`only ${tyres.length} tyres came back: not rewriting the list from that`);
  const wordsOf = title => String(title).toLowerCase().split(/[^a-z0-9]+/);
  const list = [];
  for (const [id, name, words] of BRANDS) {
    if (!fs.existsSync(path.join(ROOT, 'assets', 'img', 'brands', id + '.webp'))) { console.warn(`no logo for ${name}: left out`); continue; }
    const mine = tyres.filter(p => { const w = wordsOf(p.title); return words.every(x => w.includes(x)); });
    if (!mine.length) { console.warn(`the store lists no ${name} tyres: left out`); continue; }
    const types = Object.keys(TYPE_TAGS).filter(t => mine.some(p => p.tags.includes(TYPE_TAGS[t])));
    list.push({ id, name, words, types: types.length ? types : ['car'], n: mine.length });
  }
  const line = `window.HTA_DATA.brandTypeTags = ${JSON.stringify(TYPE_TAGS)}; window.HTA_DATA.brands = ${JSON.stringify(list)};`;
  if (process.argv.includes('--print')) { console.log(line); return; }
  const file = path.join(ROOT, 'js', 'data.js');
  const kept = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('window.HTA_DATA.brand') && !l.startsWith('/* Tyre brands'));
  const day = new Date().toISOString().slice(0, 10);
  kept.push(`/* Tyre brands: compiled from the live store's product feed on ${day} by tools/make-brand-list.js. */`, line);
  fs.writeFileSync(file, kept.join('\n') + '\n');
  console.log(`${list.length} brands written to js/data.js:`, list.map(b => `${b.name} ${b.n}`).join(', '));
})().catch(e => { console.error('Brand list not changed:', e.message); process.exit(1); });
