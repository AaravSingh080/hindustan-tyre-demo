'use strict';

/* The daily copy of the database, sent to a bucket outside the server: Amazon S3, Cloudflare R2, Backblaze B2,
   Wasabi or any other S3-compatible storage. Signed here with Signature Version 4 using only node:crypto, so
   there is no dependency to keep up. Settings come from the environment (see .env.example). */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { ConfigError } = require('./config');

const sha256 = (data, enc = 'hex') => crypto.createHash('sha256').update(data).digest(enc);
const hmac = (key, data, enc) => crypto.createHmac('sha256', key).update(data, 'utf8').digest(enc);
const encode = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/* a signed PUT. `at` is a Date; returns { url, headers } ready for fetch. Path style addressing works with every
   provider, so the object lives at https://endpoint/bucket/key. */
function signPut({ endpoint, region, bucket, key, accessKey, secret, contentSha256, contentLength, at }) {
  const url = new URL(endpoint);
  const host = url.host;
  const path = `/${encode(bucket)}/${key.split('/').map(encode).join('/')}`;
  const amzDate = at.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers = {
    host,
    'content-length': String(contentLength),
    'content-type': 'application/octet-stream',
    'x-amz-content-sha256': contentSha256,
    'x-amz-date': amzDate,
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map(n => `${n}:${headers[n].trim()}\n`).join('');
  const canonical = ['PUT', path, '', canonicalHeaders, signedNames.join(';'), contentSha256].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac('AWS4' + secret, day), kRegion = hmac(kDate, region), kService = hmac(kRegion, 's3'), kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, toSign, 'hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
  const { host: _h, ...sendHeaders } = headers;   // fetch sets Host itself
  return { url: `${url.origin}${path}`, headers: sendHeaders };
}

// reads BACKUP_S3_* from env; all four of bucket, key, secret and region/endpoint, or none
function offsiteSettings(env) {
  const has = k => typeof env[k] === 'string' && env[k].trim() !== '';
  const keys = ['BACKUP_S3_BUCKET', 'BACKUP_S3_KEY', 'BACKUP_S3_SECRET'];
  const set = keys.filter(has);
  if (!set.length && !has('BACKUP_S3_ENDPOINT') && !has('BACKUP_S3_REGION')) return null;
  if (set.length !== keys.length) throw new ConfigError('Off-site backup needs BACKUP_S3_BUCKET, BACKUP_S3_KEY and BACKUP_S3_SECRET together (plus BACKUP_S3_REGION or BACKUP_S3_ENDPOINT).');
  const bucket = env.BACKUP_S3_BUCKET.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new ConfigError('BACKUP_S3_BUCKET must be a bucket name: lower case letters, digits, dots and dashes.');
  const region = has('BACKUP_S3_REGION') ? env.BACKUP_S3_REGION.trim() : 'auto';
  if (!/^[a-z0-9-]{2,32}$/.test(region)) throw new ConfigError('BACKUP_S3_REGION must look like ap-south-1 (or "auto" for R2 and B2).');
  let endpoint = has('BACKUP_S3_ENDPOINT') ? env.BACKUP_S3_ENDPOINT.trim() : (region === 'auto' ? null : `https://s3.${region}.amazonaws.com`);
  if (!endpoint) throw new ConfigError('Set BACKUP_S3_ENDPOINT (for R2, B2, Wasabi and other providers) or an AWS BACKUP_S3_REGION.');
  let u;
  try { u = new URL(endpoint); } catch { throw new ConfigError('BACKUP_S3_ENDPOINT must be a full https address.'); }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username) throw new ConfigError('BACKUP_S3_ENDPOINT must be only the https address of the storage, with no path.');
  const prefix = has('BACKUP_S3_PREFIX') ? env.BACKUP_S3_PREFIX.trim().replace(/^\/+|\/+$/g, '') : 'hta-passport';
  if (!/^[A-Za-z0-9_./-]{0,80}$/.test(prefix)) throw new ConfigError('BACKUP_S3_PREFIX may use letters, digits, dots, dashes, underscores and slashes.');
  return { bucket, region, endpoint: u.origin, prefix, accessKey: env.BACKUP_S3_KEY.trim(), secret: env.BACKUP_S3_SECRET.trim() };
}

function makeOffsite(settings, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const clock = opts.now || Date.now;
  if (!settings) return { ready: false, describe: () => null };
  return {
    ready: true,
    // what the owner's page may show: where the copies go, never the key or the secret
    describe: () => ({ bucket: settings.bucket, endpoint: settings.endpoint, prefix: settings.prefix, region: settings.region }),
    async upload(file, name) {
      const st = fs.statSync(file);
      const key = (settings.prefix ? settings.prefix + '/' : '') + name;
      const req = signPut({ ...settings, key, contentSha256: await fileSha256(file), contentLength: st.size, at: new Date(clock()) });
      const res = await doFetch(req.url, { method: 'PUT', headers: req.headers, body: fs.createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(opts.timeoutMs || 120000) });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        throw new Error(`storage answered ${res.status}${text ? ': ' + text : ''}`);
      }
      return { key, bytes: st.size };
    },
  };
}

module.exports = { makeOffsite, offsiteSettings, signPut, fileSha256 };
