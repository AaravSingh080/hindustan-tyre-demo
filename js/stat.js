/* Counting without cookies. A page calls HTA_STAT('tyres.found') and the server adds one to that name's count
   for today. Nothing about the visitor travels with it and nothing is stored in the browser. A browser that
   asks not to be tracked (Do Not Track or Global Privacy Control) is left out entirely. */
(function () {
  'use strict';
  const quiet = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true || navigator.webdriver === true;
  const sent = new Set();
  window.HTA_STAT = function (key) {
    if (quiet || typeof key !== 'string' || !/^[a-z]+(\.[a-z0-9-]+){1,3}$/.test(key) || key.length > 48) return;
    if (/^(page|tyres)\./.test(key)) { if (sent.has(key)) return; sent.add(key); }   // a view or a step counts once per page
    try {
      fetch('/api/stat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hta': '1' }, body: JSON.stringify({ k: key }), credentials: 'omit', keepalive: true, cache: 'no-store' }).catch(function () {});
    } catch (e) { /* counting never gets in the way */ }
  };
  const page = document.body && document.body.getAttribute('data-stat');
  if (page) window.HTA_STAT('page.' + page);
})();
