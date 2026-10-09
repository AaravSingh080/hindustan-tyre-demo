'use strict';

/* Sign-in codes by SMS through MSG91's Send OTP API (v5). The code is made and checked by this server; MSG91
   only carries it. Two things about MSG91 shape this file:
   - a reply of type "success" means the request was accepted, not that a text was delivered, so nothing here
     or on screen ever says "sent" or "delivered";
   - failures usually arrive as HTTP 200 with type "error", and the reason can be in "message" or "request_id".
   The phone number and the code travel in the query string because that is the only form MSG91 documents;
   the address is never logged. */

const ENDPOINT = 'https://control.msg91.com/api/v5/otp';

function makeSms(cfg, fetchImpl = fetch) {
  if (cfg.mode === 'demo') {
    // nothing leaves this computer in demo mode; the sign-in page shows the code and says so
    return { ready: true, demo: true, async sendOtp() { return { ok: true, demo: true }; } };
  }
  if (!cfg.msg91) return { ready: false, demo: false, async sendOtp() { return { ok: false, reason: 'MSG91 keys are not set' }; } };

  return {
    ready: true,
    demo: false,
    // phone: '+91XXXXXXXXXX', code: six digits with no leading zero
    async sendOtp(phone, code) {
      const url = new URL(ENDPOINT);
      url.searchParams.set('template_id', cfg.msg91.templateId);
      url.searchParams.set('mobile', phone.replace(/\D/g, ''));
      url.searchParams.set('otp', code);
      url.searchParams.set('otp_expiry', '5');
      url.searchParams.set('realTimeResponse', '1');
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { authkey: cfg.msg91.authKey, 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(8000),
        });
        let body = null;
        try { body = await res.json(); } catch { /* not JSON: treated as a failure below */ }
        if (body && body.type === 'success') return { ok: true, requestId: String(body.request_id || '').slice(0, 60) };
        const why = body ? String(body.message || body.request_id || 'refused') : `unreadable reply (HTTP ${res.status})`;
        return { ok: false, reason: why.replace(/[^\w .,:/()-]/g, ' ').slice(0, 120) };
      } catch (e) {
        return { ok: false, reason: e && e.name === 'TimeoutError' ? 'MSG91 did not answer in time' : 'could not reach MSG91' };
      }
    },
  };
}

module.exports = { makeSms, ENDPOINT };
