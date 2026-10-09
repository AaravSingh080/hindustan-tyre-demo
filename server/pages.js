'use strict';

/* The stop-reminders pages. These are the only pages the server writes itself, because they must work with
   scripts off, inside whatever browser a WhatsApp link opens. They use the site's own stylesheets and show
   nothing about the customer. */

const shell = (title, demo, body) => `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} | Hindustan Tyre Agencies</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0d0d0e">
<link rel="icon" href="/assets/img/logo.png">
<link rel="stylesheet" href="/css/styles.css">
<link rel="stylesheet" href="/css/passport.css">
</head>
<body class="app">
${demo ? '<p class="demo-strip"><b>Demo</b> Sample customers only. No message is sent to anyone.</p>' : ''}
<header class="app-head">
  <a class="brand" href="/" aria-label="Hindustan Tyre Agencies, home">
    <span class="brand-badge"><img src="/assets/img/logo.png" alt="" width="150" height="200"></span>
    <span class="brand-name" aria-hidden="true">Hindustan<br>Tyre Agencies</span>
  </a>
</header>
<main id="main" class="app-main">
${body}
</main>
<footer class="app-foot">
  <ul>
    <li><a href="/passport/">Tyre passport</a></li>
    <li><a href="/privacy/">Privacy</a></li>
  </ul>
</footer>
</body>
</html>
`;

// token has already been checked to be letters, digits, - and _ only
const stopAsk = (token, demo) => shell('Stop reminders', demo, `  <div class="view-head">
    <p class="kicker">Reminders</p>
    <h1 class="display">Stop <em>reminders?</em></h1>
  </div>
  <form class="sign form" method="post" action="/stop">
    <input type="hidden" name="t" value="${token}">
    <p>Press the button and Hindustan Tyre Agencies will stop sending tyre and service reminders to this number on WhatsApp. Your tyre passport, warranty and free services stay exactly as they are.</p>
    <button class="plate plate-k" type="submit"><span class="plate-txt">Stop reminders</span></button>
    <p class="muted">Opened this by mistake? Close the page. Nothing changes until you press the button.</p>
  </form>`);

// the same words whether or not the link was still good
const stopDone = demo => shell('Reminders stopped', demo, `  <div class="view-head">
    <p class="kicker">Reminders</p>
    <h1 class="display">Reminders <em>stopped</em></h1>
  </div>
  <div class="sign">
    <p>If this link was for your number, we will not send it any more tyre or service reminders. Your tyre passport, warranty and free services are unchanged.</p>
    <p>Changed your mind? Sign in to your tyre passport and switch reminders back on. Only you can do that.</p>
    <a class="plate" href="/passport/"><span class="plate-txt">Open my passport</span></a>
  </div>`);

const stopBroken = demo => shell('Stop reminders', demo, `  <div class="view-head">
    <p class="kicker">Reminders</p>
    <h1 class="display">This link is <em>not complete</em></h1>
  </div>
  <div class="sign">
    <p>Open the link from the message again, reply STOP to the message, or tell us at the shop on 83034 00005.</p>
  </div>`);

const stopBusy = demo => shell('Stop reminders', demo, `  <div class="view-head">
    <p class="kicker">Reminders</p>
    <h1 class="display">Try again <em>shortly</em></h1>
  </div>
  <div class="sign">
    <p>Too many requests came from this connection. Wait a few minutes and press the link again, or reply STOP to the message.</p>
  </div>`);

module.exports = { stopAsk, stopDone, stopBroken, stopBusy };
