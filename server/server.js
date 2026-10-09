'use strict';

/* Starts the site: `npm start`. With no keys set it runs the demo on this computer only. */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PINNED = '22.15.1';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`This server needs Node ${PINNED} (it uses the built-in SQLite). You are on ${process.versions.node}.`);
  process.exit(1);
}
if (process.versions.node !== PINNED) console.warn(`Note: tested on Node ${PINNED}; this is ${process.versions.node}.`);

// keys for a local trial can sit in a .env file next to package.json; on a host they belong in its settings
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { createApp } = require('./app');
const { ConfigError } = require('./config');

let app;
try {
  app = createApp({ log: line => console.log(line) });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`\nCannot start: ${e.message}\n`);
  process.exit(1);
}

const { cfg } = app;
// on a live site the process id is written beside the database, so restore.js can tell the server is running
const pidFile = cfg.mode === 'live' ? path.join(cfg.dataDir, 'server.pid') : null;
if (pidFile) { try { fs.writeFileSync(pidFile, String(process.pid)); } catch (e) { console.warn(`could not write ${pidFile}: ${e.message}`); } }
const server = http.createServer(app.handler);
// slow or stalled connections are dropped rather than held open
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;

app.housekeeping();
setInterval(() => app.housekeeping(), 6 * 3600e3).unref();

server.listen(cfg.port, cfg.host, () => {
  const at = cfg.publicBaseUrl || `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${server.address().port}`;
  if (cfg.mode === 'demo') {
    console.log(`\nDEMO MODE at ${at}\n  Sample customers only. No SMS or WhatsApp message is sent.\n  Staff page: ${at}/staff/  (demo PIN ${cfg.staffPin})\n  Passport:   ${at}/passport/\n`);
  } else {
    console.log(`\nLIVE at ${at}\n  Database: ${app.db.file}\n  Sign-in codes by SMS: ${app.sms.ready ? 'on (MSG91)' : 'OFF, set MSG91_AUTH_KEY and MSG91_TEMPLATE_ID'}\n  Proxies trusted: ${cfg.trustProxy}\n`);
  }
});

const stop = () => server.close(() => { app.close(); if (pidFile) { try { fs.unlinkSync(pidFile); } catch (e) { /* already gone */ } } process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
