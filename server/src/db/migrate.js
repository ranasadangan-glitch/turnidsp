// Runs the schema (and optionally seeds) against the configured database.
// Reads the connection (incl. SSL) from src/db/pool.js, which honors
// DATABASE_URL + SSL automatically (Render/Railway/Heroku compatible).
//
// Usage:
//   node src/db/migrate.js          -> schema + indexes (idempotent)
//   node src/db/migrate.js --seed   -> schema + indexes + seed data
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./pool');

async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  console.log('Running', path.basename(file), '...');
  await pool.query(sql);
}

// Guarantees a working admin login even if the seed step was never run.
// Only inserts when the users table is empty, so it never overwrites real data.
async function ensureAdmin() {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  const reset = process.env.RESET_ADMIN === 'true';

  // Does the admin account exist at all?
  const adm = await pool.query('SELECT id, password_hash, active FROM users WHERE lower(username)=$1', [username]);
  const exists = adm.rowCount > 0;

  // Create if missing, or (re)set when RESET_ADMIN=true, or if the row is inactive.
  const needFix = !exists || reset || (exists && adm.rows[0].active === false);
  if (needFix) {
    const hash = bcrypt.hashSync(pw, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, active)
       VALUES ($1, $2, 'Amministratore', 'admin', TRUE)
       ON CONFLICT (username)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE, role = 'admin'`,
      [username, hash]
    );
    const how = !exists ? 'created' : (reset ? 'reset (RESET_ADMIN=true)' : 're-activated');
    console.log(`Admin bootstrap: ${how} login "${username}" (password ${process.env.ADMIN_PASSWORD ? 'from ADMIN_PASSWORD' : '"admin123"'}). Change it after first login.`);
  } else {
    console.log(`Admin bootstrap: login "${username}" already present and active. To reset its password set RESET_ADMIN=true (and optionally ADMIN_PASSWORD) and redeploy.`);
  }
}

(async () => {
  try {
    const root = path.resolve(__dirname, '../../database');
    // Schema is idempotent (CREATE/ALTER ... IF NOT EXISTS) so it is safe to
    // run on every deploy.
    await runFile(path.join(root, 'schema', '01_schema.sql'));
    await runFile(path.join(root, 'schema', '03_contract.sql'));
    await runFile(path.join(root, 'schema', '04_indexes.sql'));
    await runFile(path.join(root, 'schema', '05_security.sql'));
    await runFile(path.join(root, 'schema', '06_scheduler.sql'));
    await runFile(path.join(root, 'schema', '07_platform.sql'));
    if (process.argv.includes('--seed')) {
      await runFile(path.join(root, 'seeds', '02_seed.sql'));
    }
    // Always make sure a login exists (no-op if users already present).
    await ensureAdmin();
    console.log('Migration complete.');
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e.message);
    // Common, actionable hints
    if (/SSL|TLS/i.test(e.message)) {
      console.error(
        'Hint: the database requires SSL. Ensure DATABASE_URL is set and, if needed, set PGSSL=true. ' +
        'This project enables SSL automatically when DATABASE_URL is present.'
      );
    }
    if (/ECONNREFUSED|ENOTFOUND|timeout/i.test(e.message)) {
      console.error('Hint: cannot reach the database. Check DATABASE_URL host/port and that the DB is running.');
    }
    try { await pool.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
})();
