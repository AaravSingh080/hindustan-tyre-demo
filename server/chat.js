'use strict';

/* The chat assistant. Two ways of answering, chosen at start-up:
   - with ANTHROPIC_API_KEY set: Claude, through the official SDK, told the shop's facts and told what not to make up;
   - without it: a built-in answerer that matches the question against the FAQ in config/chatbot.json.
   Either way the facts come from that one file, the page never calls the model directly, and nothing a visitor
   types is kept on the server. */

const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./config');

// a problem in config/chatbot.json or CHAT_MODEL stops the server at start, like any other setting
class ChatConfigError extends ConfigError {}

const need = (ok, msg) => { if (!ok) throw new ChatConfigError('config/chatbot.json: ' + msg); };
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;

function readKnowledge(file) {
  let k;
  try { k = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ChatConfigError(`cannot read ${file}: ${e.message}`); }
  need(k && typeof k === 'object', 'the file must be one JSON object');
  need(str(k.name, 2, 60), '"name" must be 2 to 60 characters');
  need(str(k.greeting, 10, 400), '"greeting" must be 10 to 400 characters');
  need(str(k.offline_note, 10, 300), '"offline_note" must be 10 to 300 characters');
  need(str(k.fallback, 10, 400), '"fallback" must be 10 to 400 characters');
  need(Array.isArray(k.facts) && k.facts.length >= 1 && k.facts.length <= 60 && k.facts.every(f => str(f, 10, 600)), '"facts" must list 1 to 60 sentences of up to 600 characters');
  need(Array.isArray(k.quick) && k.quick.length >= 1 && k.quick.length <= 8 && k.quick.every(q => str(q, 4, 80)), '"quick" must list 1 to 8 questions of up to 80 characters');
  need(Array.isArray(k.faq) && k.faq.length >= 1 && k.faq.length <= 60, '"faq" must list 1 to 60 entries');
  k.faq.forEach((f, i) => {
    need(f && Array.isArray(f.words) && f.words.length >= 1 && f.words.every(w => str(w, 1, 40)), `"faq[${i}].words" must be a list of words`);
    need(str(f.answer, 10, 700), `"faq[${i}].answer" must be 10 to 700 characters`);
  });
  return k;
}

/* ---------- the built-in answerer ---------- */

const norm = s => s.toLowerCase().replace(/[^a-z0-9ऀ-੿\s/.-]/g, ' ').replace(/\s+/g, ' ').trim();

// words with a simple plural or past-tense ending folded, so "tyres fitted" matches "tyre" and "fit"
const stem = w => w.replace(/(ies)$/, 'y').replace(/(sses|shes|ches|xes)$/, m => m.slice(0, -2)).replace(/([^s])s$/, '$1').replace(/(ted|ing)$/, (m, o, str) => (str.length > 5 ? '' : m));
const words = s => norm(s).split(' ').filter(Boolean).map(stem);

// the FAQ entry whose trigger words appear most in the question; longer triggers count for more,
// each trigger counts once, and a tie goes to the entry whose matched triggers were longer
function localAnswer(k, text) {
  const q = ' ' + words(text).join(' ') + ' ';
  const plain = ' ' + norm(text) + ' ';
  let best = null, bestScore = 0, bestLen = 0;
  for (const f of k.faq) {
    let score = 0, len = 0;
    for (const w of new Set(f.words.map(norm))) {
      const stemmed = ' ' + words(w).join(' ') + ' ';
      if (w && (q.includes(stemmed) || plain.includes(' ' + w + ' '))) { score += 1 + Math.min(w.length, 12) / 12; len += w.length; }
      else if (w.length >= 5 && plain.includes(w)) { score += 0.6; len += w.length; }
    }
    if (score > bestScore || (score === bestScore && score > 0 && len > bestLen)) { best = f; bestScore = score; bestLen = len; }
  }
  return bestScore >= 1 ? best.answer : k.fallback;
}

/* ---------- Claude ---------- */

function systemPrompt(k, shop) {
  return [
    `You are ${k.name}, the chat assistant on the website of ${shop.name}, a tyre dealer in Ludhiana, Punjab, India. You help visitors with tyres, sizes, fitting, warranty, delivery and the shop's tyre passport. The shop's WhatsApp number is +${shop.whatsapp}.`,
    'Rules:',
    '- Answer only from the facts below. If the facts do not cover it, say so plainly and point to the shop\'s WhatsApp number or the Find my tyres page at /tyres/. Never invent prices, stock, offers, opening hours, delivery times or policies.',
    '- Keep answers short: two to four sentences, plain words, no bullet lists unless the person asks for steps. No emoji. No em dashes or en dashes.',
    '- Reply in the language the person writes in. English, Hindi (Devanagari) and Punjabi (Gurmukhi) are all fine; if they write Hindi or Punjabi in Latin letters, answer the same way.',
    '- Do not ask for or store personal details. If someone shares a phone number or vehicle number, do not repeat it back; just answer.',
    '- You are an automated assistant. If asked, say so, and that a person replies on WhatsApp.',
    '- For anything about a specific customer\'s bill, warranty claim, passport sign-in trouble or a complaint, send them to WhatsApp or the shop; do not guess.',
    '',
    'Facts about the shop:',
    ...k.facts.map(f => '- ' + f),
  ].join('\n');
}

// the request below (adaptive thinking with an effort setting, server-side fallback) needs the Claude 5 family or Opus/Sonnet 4.6 and later
const MODEL_RE = /^claude-(?:(?:opus|sonnet|fable|haiku)-5(?:-\d{1,2})?|opus-4-[6-9]|sonnet-4-[6-9])(?:-\d{8})?$/;

function makeChat(cfg, opts = {}) {
  const k = opts.knowledge || readKnowledge(opts.knowledgeFile || path.join(cfg.root, 'config', 'chatbot.json'));
  const env = opts.env || process.env;
  const log = opts.log || (() => {});
  const shop = cfg.settings.shop;
  const key = typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim();
  const model = typeof env.CHAT_MODEL === 'string' && env.CHAT_MODEL.trim() ? env.CHAT_MODEL.trim() : 'claude-opus-5-5';
  if (!MODEL_RE.test(model)) throw new ChatConfigError('CHAT_MODEL must be a Claude 5 model (such as claude-opus-5-5 or claude-sonnet-5-5) or Opus/Sonnet 4.6 or later.');

  const chat = { knowledge: k, mode: 'local', model: null, local: text => localAnswer(k, text) };
  if (!key) return chat;

  // the SDK reads ANTHROPIC_API_KEY itself; it is never logged or sent to the page
  const Anthropic = require('@anthropic-ai/sdk');
  const client = opts.client || new Anthropic({ apiKey: key, maxRetries: 1, timeout: 20000 });
  const system = [{ type: 'text', text: systemPrompt(k, shop), cache_control: { type: 'ephemeral' } }];
  chat.mode = 'claude';
  chat.model = model;

  // messages: [{ role: 'user' | 'assistant', text }] already checked by the route; returns { text, source }
  chat.answer = async messages => {
    try {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 2048,                         // room for the model's thinking and a short answer
        output_config: { effort: 'low' },        // a chat line, not an essay
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',                     // a declined request is re-run on a fallback model by category
        system,
        messages: messages.map(m => ({ role: m.role, content: m.text })),
      });
      if (response.stop_reason === 'refusal') return { text: k.fallback, source: 'local' };
      let text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text) return { text: k.fallback, source: 'local' };
      if (response.stop_reason === 'max_tokens') { log('chat: an answer was cut short at max_tokens'); text += ' (The answer was cut short. WhatsApp us for the rest.)'; }
      return { text, source: 'claude' };
    } catch (e) {
      // the shop's assistant must keep answering when the model does not: the built-in answerer steps in
      if (e instanceof Anthropic.AuthenticationError) log('chat: the Anthropic API key was refused; answering from the FAQ instead');
      else if (e instanceof Anthropic.BadRequestError) log(`chat: the API refused the request (${String(e.message).slice(0, 120)}); check CHAT_MODEL; answering from the FAQ`);
      else if (e instanceof Anthropic.RateLimitError) log('chat: rate limited by the API; answering from the FAQ for this message');
      else if (e instanceof Anthropic.APIError) log(`chat: API error ${e.status}; answering from the FAQ for this message`);
      else log('chat: could not reach the API; answering from the FAQ for this message');
      const last = messages[messages.length - 1];
      return { text: localAnswer(k, last ? last.text : ''), source: 'local' };
    }
  };
  return chat;
}

module.exports = { makeChat, readKnowledge, localAnswer, systemPrompt, ChatConfigError };
