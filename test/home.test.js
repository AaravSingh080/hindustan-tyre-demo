'use strict';

/* The home page's scroll scenes and text motion, checked from the files themselves: every frame sequence the
   script names is on disk and complete, the hero is scrubbed by the scroll rather than played, the pieces the
   scroll engine looks up exist in the markup, and the page still reads with scripts off or motion reduced. */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = read('index.html'), js = read('js/main.js'), css = read('css/styles.css');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
// a number written in the script, or the value of the constant it names
const numberOf = token => (/^\d+$/.test(token) ? Number(token) : Number((new RegExp(`\\b${token}\\s*=\\s*(\\d+)`).exec(js) || [])[1]));

describe('scroll scenes', () => {
  const named = [...js.matchAll(/seq\('([a-z-]+)',\s*([A-Z_]+|\d+)/g)].map(m => [m[1], numberOf(m[2])]);

  test('every frame sequence the script names is on disk, complete and numbered without gaps', () => {
    assert.deepEqual(named.map(n => n[0]).sort(), ['grip', 'hero', 'hero-tall', 'net']);
    for (const [name, count] of named) {
      assert.ok(count > 20, `${name}: the script must say how many frames there are`);
      const files = fs.readdirSync(path.join(ROOT, 'assets', 'seq', name)).filter(f => /^f_\d{4}\.webp$/.test(f)).sort();
      assert.equal(files.length, count, `assets/seq/${name} holds ${files.length} frames, the script expects ${count}`);
      files.forEach((f, i) => assert.equal(f, `f_${String(i + 1).padStart(4, '0')}.webp`, `assets/seq/${name} has a gap at frame ${i + 1}`));
    }
  });

  test('every still a scene falls back to is on disk', () => {
    const stills = [...js.matchAll(/still:\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(stills.length >= 4);
    for (const s of stills) assert.ok(exists(s), s);
  });

  test('the hero is scrubbed by the scroll, not played: one pinned frame, a canvas, two cuts of the same length, no video', () => {
    const hero = html.slice(html.indexOf('<section class="hero"'), html.indexOf('</section>', html.indexOf('<section class="hero"')));
    assert.doesNotMatch(html, /<video\b/, 'no video element is left on the home page');
    assert.doesNotMatch(js, /\.play\(\)|hero-video|film-toggle/, 'nothing in the script plays a film');
    assert.match(hero, /<div class="hero-pin">[\s\S]*<canvas id="hero-canvas"><\/canvas>/);
    assert.match(hero, /<img class="hero-poster"[^>]*fetchpriority="high"/, 'the first frame is in the markup, so the hero paints before any script runs');
    for (const m of hero.matchAll(/(?:src|srcset)="([^"]+\.webp)"/g)) assert.ok(exists(m[1]), m[1]);
    const count = Object.fromEntries(named);
    assert.equal(count.hero, count['hero-tall'], 'the wide and the tall cut must be the same length, or turning a phone would jump');
    assert.match(css, /\.js:not\(\.rm\):not\(\.hero-flat\) \.hero \{ height: \d+vh; \}/, 'the runway exists only when scripts run, motion is wanted and the copy fits the frame');
    assert.match(css, /\.js:not\(\.rm\):not\(\.hero-flat\) \.hero-pin \{ position: sticky;/);
    assert.match(html, /<script src="js\/main\.js" onerror="document\.documentElement\.classList\.remove\('js'\)"><\/script>/, 'a script that never arrives leaves the page as it is with scripts off');
  });

  test('the promises that ride over the film are real content, shown without scripts and under reduced motion', () => {
    assert.match(html, /<div class="hero-proof">[\s\S]*Genuine Warranty[\s\S]*Pan India Delivery[\s\S]*Secure Payments/);
    assert.match(css, /\.js:not\(\.rm\):not\(\.hero-flat\) \.hero-proof \{[^}]*opacity: 0;/, 'hidden only when the scroll is there to bring them up');
    assert.doesNotMatch(css, /^\.hero-proof \{[^}]*(opacity: 0|display: none|visibility: hidden)/m);
    assert.doesNotMatch(js, /heroProof[^;]*\.inert|heroIn[^;]*\.inert/, 'copy that has left the frame stays in the page for screen readers');
  });

  test('every element the scroll engine looks up is in the markup', () => {
    const block = js.slice(js.indexOf('const el = {'), js.indexOf('};', js.indexOf('const el = {')));
    const selectors = [...block.matchAll(/\$\$?\('([^']+)'\)/g)].map(m => m[1]);
    assert.ok(selectors.length > 20);
    for (const sel of selectors) {
      for (const part of sel.split(',').map(s => s.trim().split(/\s+/)[0])) {
        const m = /^([.#])([\w-]+)/.exec(part);
        if (!m) continue;
        const re = m[1] === '#' ? new RegExp(`id="${m[2]}"`) : new RegExp(`class="[^"]*\\b${m[2]}\\b[^"]*"`);
        assert.match(html, re, `${sel}: nothing in index.html matches ${part}`);
      }
    }
  });
});

describe('the files the old hero used', () => {
  test('nothing on the page asks for the film or the square tyre sequence any more', () => {
    for (const f of [html, js, css]) {
      assert.doesNotMatch(f, /assets\/video\//);
      assert.doesNotMatch(f, /seq\/tyre\b|seq\('tyre'/);
    }
  });
});

/* ---------- text motion: road lettering ---------- */

describe('road lettering', () => {
  const STATES = /\.is-(raw|run|tie|bead|tick|thud|hold|fuse|seat|lock)\b/;
  const KINDS = /\.rl\b|\.rl-(word|head|lamp|air|true|lane|bar)\b/;
  // every style rule outside @keyframes, as [selector list, body]
  const rules = [];
  {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const m of flat.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) rules.push([m[1].trim(), m[2]]);
  }

  test('the template reveals are gone: no letter spans, no fade-up, no swing, no rise', () => {
    assert.doesNotMatch(css, /\.sw\b|\.sc\b|swing-in|@keyframes rise|\[data-reveal\][^{]*\{[^}]*opacity: 0/);
    assert.doesNotMatch(css, /translateY\(24px\)|translateY\(108%\)/);
    assert.doesNotMatch(js, /className = 'sc'|className = 'sw'|revealTargets/);
    assert.doesNotMatch(html, /data-reveal="swing"/);
  });

  test('a heading keeps its own words: nothing is split, emptied, relabelled or hidden from a screen reader', () => {
    const heads = [...html.matchAll(/<h2[^>]*data-split[^>]*>([^<]+)<\/h2>/g)].map(m => m[1].trim());
    assert.equal(heads.length, 8);
    for (const text of heads) assert.ok(text.length > 5, text);
    const block = js.slice(js.indexOf('road lettering: every word arrives'), js.indexOf('gallery shots open'));
    assert.ok(block.length > 2000, 'the road lettering block is in the script');
    assert.doesNotMatch(block, /textContent\s*=|innerHTML|aria-label|aria-hidden|createElement/, 'the lettering never rewrites the heading');
  });

  test('every unfinished look sits behind html.road, so a script that fails leaves finished text', () => {
    const stateRules = rules.filter(([sel]) => STATES.test(sel) || /:not\(\.is-set\)/.test(sel));
    assert.ok(stateRules.length >= 12, `found ${stateRules.length} state rules`);
    for (const [sel] of stateRules) {
      for (const one of sel.split(',').map(x => x.trim())) assert.match(one, /^html\.road /, `"${one}" is not gated`);
    }
    // the gate goes on last, after everything is measured and just before the first frame, and comes off on any error
    const arm = js.indexOf("root.classList.add('road')");
    assert.ok(arm > 0 && js.indexOf("root.classList.add('road')", arm + 1) < 0, 'the class is added in one place');
    assert.match(js, /measure\(\);\s*roadArm\(\);\s*update\(scrollY, 0\);\s*requestAnimationFrame\(loop\);/);
    assert.match(js, /addEventListener\('error', roadOff\)/);
    assert.match(js, /const roadOff = \(\) => \{[^}]*root\.classList\.remove\('road'\)/);
    assert.match(js, /it\.life > 4\) \{ roadSet\(it\)/, 'nothing can be left unfinished for more than a few seconds');
  });

  test('reduced motion and Data Saver register nothing, so there is nothing to finish', () => {
    assert.match(js, /if \(!RM && !LITE\) \{\s*\$\$\('h2\[data-split\]'\)/);
    // inside update(), the early return for reduced motion comes before anything the lettering does
    const body = js.slice(js.indexOf('function update(sy, dt) {'));
    assert.ok(body.indexOf('if (RM) return;') > 0 && body.indexOf('if (RM) return;') < body.indexOf('if (road.on) {'));
  });

  test('nothing is hidden or faded: unfinished text is dull, never invisible, and controls are never dimmed', () => {
    for (const [sel, body] of rules) {
      if (!KINDS.test(sel)) continue;
      // read as a number, so .05 and 0.05 are both seen
      for (const m of body.matchAll(/opacity:\s*(\d*\.?\d+)/g)) assert.ok(Number(m[1]) >= 0.6, `${sel} would hide or nearly hide text (opacity ${m[1]})`);
      // the same floor for the lettering's masks: full strength, a see-through cut, or a dimmed layer no fainter than half
      for (const m of body.matchAll(/rgba\(0, 0, 0, (\d*\.?\d+)\)/g)) assert.ok(Number(m[1]) >= 0.5, `${sel} masks text down to ${m[1]}`);
      assert.doesNotMatch(body, /(?:^|[;\s])color:\s*transparent|text-fill-color/, `${sel}: the words are never made see-through`);
      assert.doesNotMatch(body, /display:\s*none/, sel);
      if (/visibility:\s*hidden/.test(body)) assert.match(sel, /\.hero-cue/, 'only the scroll cue switches on; no words are hidden');
      assert.doesNotMatch(body, /filter:|text-shadow|backdrop-filter/, `${sel}: no blur or glow`);
    }
    assert.match(css, /html\.road \.rl-bar\.is-raw:not\(\.rl-solid\) \{ opacity: \.6\d?; \}/);
    assert.match(js, /it\.el\.matches\('a, button, \.board'\) \|\| it\.el\.querySelector\('a, button, input, select'\)\)\) it\.el\.classList\.add\('rl-solid'\)/, 'anything that can be pressed is marked solid');
    // the mask on waiting paragraphs keeps them readable
    assert.match(css, /rgba\(0, 0, 0, \.68\)/);
  });

  test('every tone change is a step: no soft easing on colour or opacity anywhere in the system', () => {
    for (const [sel, body] of rules) {
      if (!KINDS.test(sel) && !/\.hero-proof li/.test(sel)) continue;
      const tr = /transition:([^;}]+)/.exec(body);
      if (tr) assert.doesNotMatch(tr[1], /\b(color|opacity|all)\b/, `${sel} eases ${tr[1].trim()}`);
    }
    assert.match(css, /@keyframes rl-thud \{ 0%, 49% \{ transform: translateY\(-3px\); \} 50%, 100% \{ transform: none; \} \}/, 'a bar kicks and returns; it does not rise into place');
  });

  test('the lane line under a heading is six whole dashes, laid one at a time', () => {
    assert.match(css, /width: 132px; height: 3px; background: repeating-linear-gradient\(90deg, var\(--sign-text\) 0 14px, transparent 14px 22px\)/);
    assert.match(css, /html\.road h2\.rl-head\.is-set::after \{ clip-path: inset\(0\); transition: clip-path \.4s steps\(6, end\)/);
  });

  test('sections do not all arrive the same way: four kinds of heading, and no two neighbours alike', () => {
    const kinds = [...html.matchAll(/<h2[^>]*\bdata-split(?:="([a-z]*)")?[^>]*>/g)].map(m => m[1] || 'word');
    assert.equal(kinds.length, 8);
    assert.deepEqual([...new Set(kinds)].sort(), ['air', 'lamp', 'true', 'word']);
    // the headline of the page is carriageway paint too, so the first heading under it is something else
    ['word', ...kinds].forEach((k, i, all) => { if (i) assert.notEqual(k, all[i - 1], `headings ${i - 1} and ${i} both arrive as ${k}`); });
    for (const k of new Set(kinds)) {
      assert.match(js, new RegExp(`\\b${k}: \\{ D: [\\d.]+, T: [\\d.]+, after: \\[`), `the script knows how a ${k} heading is driven`);
      if (k !== 'word') assert.ok(rules.some(([sel]) => sel.includes(`html.road .rl-${k}.is-raw`)), `the stylesheet says how a ${k} heading looks before it is finished`);
    }
    assert.match(js, /const ROAD_HEADS = \{ word: 1, lamp: 1, air: 1, true: 1 \};/);
    assert.match(js, /ROAD_HEADS\[h\.dataset\.split\] \? h\.dataset\.split : 'word'/, 'a kind the script does not know falls back to paint');
  });

  test('the message board has a whole number of lamp rows to a line, and the script counts the same number', () => {
    const m = /\.rl-lamp \{ --lh: \.(\d+)em; --pt: \.(\d+)em;/.exec(css);
    assert.ok(m, 'the lamp pitch is declared');
    const rows = Number('0.' + m[1]) / Number('0.' + m[2]);
    assert.ok(Math.abs(rows - Math.round(rows)) < 1e-9, `${rows} rows to a line`);
    assert.equal(Number((/const LAMP_ROWS = (\d+);/.exec(js) || [])[1]), Math.round(rows));
    assert.match(css, new RegExp(`html\\.road \\.rl-lamp\\.is-hold \\{ --lit: ${Math.round(rows)}; \\}`), 'the held message has every row lit');
    assert.match(css, /rgba\(0, 0, 0, \.5\)/, 'unlit lamps are dim, not dark: the words can be read before the sign is reached');
  });

  test('the instruments over a heading are drawn, not written: a screen reader hears only the heading', () => {
    for (const [sel, body] of rules) {
      if (!/\.rl-(air|true)\b.*::before/.test(sel)) continue;
      const content = /content:\s*([^;]+);/.exec(body);
      if (content) assert.equal(content[1].trim(), '""', `${sel} adds words to the heading`);
    }
    assert.match(css, /@keyframes rl-thud/);
    assert.doesNotMatch(css, /\.rl-air[^{]*\{[^}]*cubic-bezier|\.rl-true[^{]*\{[^}]*cubic-bezier/, 'a pump and a spanner do not overshoot');
  });

  test('a short screen gets the hero laid out flat instead of a pinned frame that cuts its own copy', () => {
    assert.match(js, /root\.classList\.remove\('hero-flat'\);[\s\S]{0,700}root\.classList\.toggle\('hero-flat', heroFlat\);/, 'measured in the pinned layout first, then decided');
    assert.match(js, /if \(M\.hero\.flat\) \{/, 'the scroll drives nothing in a flat hero');
    const pinned = [...css.matchAll(/\.js:not\(\.rm\)(:not\(\.hero-flat\))? \.hero(?:-pin|-in|-cue|-proof)? \{/g)];
    assert.ok(pinned.length >= 10);
    for (const m of pinned) assert.ok(m[1], `${m[0]} would still pin a flat hero`);
    for (const sel of ['.hero-proof ul', '.hero-proof li', '.hero-in']) assert.ok(css.includes(`html:not(.js) ${sel}, .hero-flat ${sel} {`), `${sel} takes the no-script layout when flat`);
  });

  test('nothing in the hero is left half done or dead: promises finish on the clock, buttons stay live, the cut follows a real turn', () => {
    assert.match(js, /const want = shown && \(begun \|\| p > 0\.34 \+ i \* 0\.15 \|\| \(turn && road\.still > 0\.5\)\);/);
    assert.doesNotMatch(js, /heroIn\.style\.pointerEvents/, 'the buttons answer for as long as they can be seen');
    assert.match(js, /byKeyboard\(e\.target\)\) scrollTo\(/, 'a mouse press on a hero button does not send the page to the top under the pointer');
    assert.match(js, /if \(innerWidth === heroCut\.w\) return;/, 'a keyboard opening does not fetch the other cut');
    assert.match(js, /im\.onload = keep;/);
    assert.doesNotMatch(js, /\.decode\(\)/, 'frames are not decoded twice');
    assert.match(js, /if \(cfg\.blend && Math\.abs\(x - this\.x\) < 1\)/, 'two frames are mixed only while the scrub is slow');
  });

  test('a slow unbroken scroll does not cut a heading short, and nothing finished is started again', () => {
    // the clock goes to full rate before the four second net, with room left for the longest closing beats
    assert.match(js, /\(still \|\| it\.life > 4 - R\.T - 0\.8 \? dt \/ R\.T : seen > 0 \? 0\.3 \* dt \/ R\.T : 0\)/);
    const table = js.slice(js.indexOf('const ROAD = {'), js.indexOf('const ROAD_HEADS'));
    const beat = Object.fromEntries([...(/const ROAD_BEAT = \{([^}]+)\}/.exec(js)[1]).matchAll(/(\w+): ([\d.]+)/g)].map(m => [m[1], Number(m[2])]));
    for (const m of table.matchAll(/(\w+): \{ D: [\d.]+, T: ([\d.]+), after: \[([^\]]*)\] \}/g)) {
      if (!['word', 'lamp', 'air', 'true'].includes(m[1])) continue;
      const beats = m[3].split(',').map(x => x.trim().replace(/'/g, '')).reduce((sum, b) => sum + beat[b], 0);
      // full rate starts at 4 - T - 0.8, the run then takes T, then the beats: all inside the four seconds
      assert.ok(4 - 0.8 + beats < 4, `${m[1]}: closing beats of ${beats}s do not fit before the net`);
    }
    assert.match(js, /const roadStart = it => \{\s*if \(it\.phase !== 'wait'\) return;/);
  });

  test('the hero joins in: the headline waits long under the loading plate, the gantry waits with it, the promises are finished by the scroll', () => {
    assert.match(css, /html\.road h1\.rl-word\.is-raw \{ transform: scaleY\(2\.6\); \}/);
    assert.match(css, /\.js\.is-loading:not\(\.rm\) \.gantry \{ animation-play-state: paused; \}/);
    assert.doesNotMatch(css, /\.hero-proof li \{[^}]*(transition|translateX)/);
    assert.match(js, /roadAdd\(\$\('#hero-title'\), 'word', \{ hero: true \}\)/);
    assert.match(js, /\$\$\('\.hero-proof li'\)\.forEach\(li => road\.proof\.push\(roadAdd\(li, 'proof'\)\)\)/);
    assert.doesNotMatch(js, /heroIn\.style\.opacity/, 'the headline leaves by passing under the camera, not by fading');
  });
});

