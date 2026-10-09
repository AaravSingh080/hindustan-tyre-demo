'use strict';

/* Puts a backup copy back in place of the live database.

     node server/restore.js /path/to/passport-2026-10-07.sqlite

   Stop the server first. The copy is checked (it must open as a database made by this server), the current
   database is kept beside it as passport.before-restore-<time>.sqlite, and the copy becomes passport.sqlite.
   Start the server again afterwards. DATA_DIR comes from the environment or the .env file, as for the server. */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function checkCopy(file, expectVersion) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${file} is not a file`);
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== 'SQLite format 3\0') throw new Error('that file is not a SQLite database');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const ok = db.prepare('PRAGMA quick_check').get();
    if (!ok || ok.quick_check !== 'ok') throw new Error('the database file is damaged (quick_check failed)');
    const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!v) throw new Error('that database was not made by this server (no schema version)');
    if (Number(v.value) > expectVersion) throw new Error(`that copy is at schema ${v.value}, newer than this server (${expectVersion}); update the server first`);
    const customers = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
    return { schema: Number(v.value), customers };
  } finally { db.close(); }
}

// the server writes its process id to DATA_DIR/server.pid while it runs
function serverRunning(dataDir) {
  const f = path.join(dataDir, 'server.pid');
  if (!fs.existsSync(f)) return false;
  const pid = Number(fs.readFileSync(f, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// replaces dataDir/passport.sqlite with the copy; returns where the old database went
function restore(copy, dataDir, expectVersion, now = Date.now()) {
  const info = checkCopy(copy, expectVersion);
  const live = path.join(dataDir, 'passport.sqlite');
  const wal = live + '-wal';
  if (serverRunning(dataDir)) throw new Error('the server is running (see server.pid in DATA_DIR). Stop it, then try again.');
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) throw new Error(`${wal} is not empty: the server seems to be running. Stop it, then try again.`);
  let kept = null;
  if (fs.existsSync(live)) {
    kept = path.join(dataDir, `passport.before-restore-${new Date(now).toISOString().replace(/[:.]/g, '-')}.sqlite`);
    fs.copyFileSync(live, kept);
  }
  // write to a temporary name, then move it over, so a failure half way leaves the old file untouched
  const tmp = live + '.restoring';
  fs.copyFileSync(copy, tmp);
  for (const side of [wal, live + '-shm']) if (fs.existsSync(side)) fs.unlinkSync(side);
  fs.renameSync(tmp, live);
  return { ...info, kept, live };
}

if (require.main === module) {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const copy = process.argv[2];
  if (!copy) { console.error('Usage: node server/restore.js <backup copy .sqlite>'); process.exit(2); }
  const dataDir = process.env.DATA_DIR ? path.resolve(path.join(__dirname, '..'), process.env.DATA_DIR) : null;
  if (!dataDir) { console.error('DATA_DIR is not set. Set it (or put it in .env) so the copy goes where the server looks.'); process.exit(2); }
  const { SCHEMA_VERSION } = require('./db');
  try {
    const out = restore(path.resolve(copy), dataDir, SCHEMA_VERSION);
    console.log(`Restored ${copy} (${out.customers} customers, schema ${out.schema}) to ${out.live}.`);
    if (out.kept) console.log(`The previous database is kept at ${out.kept}. Delete it when you are sure.`);
    console.log('Start the server again.');
  } catch (e) {
    console.error(`Not restored: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { restore, checkCopy, serverRunning };
