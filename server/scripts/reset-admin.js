// Reset (or create) the admin login. Works even if the user already exists.
// Usage:
//   node scripts/reset-admin.js                 -> admin / admin123
//   node scripts/reset-admin.js MyNewPass        -> admin / MyNewPass
//   ADMIN_USERNAME=boss ADMIN_PASSWORD=Secret node scripts/reset-admin.js
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db/pool');

(async () => {
  try {
    const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const pw = process.env.ADMIN_PASSWORD || process.argv[2] || 'admin123';
    const hash = bcrypt.hashSync(pw, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, active)
       VALUES ($1, $2, 'Amministratore', 'admin', TRUE)
       ON CONFLICT (username)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE, role = 'admin'`,
      [username, hash]
    );
    console.log(`OK: admin login "${username}" is ready. Password ${process.env.ADMIN_PASSWORD || process.argv[2] ? 'set as provided' : '= admin123'}.`);
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('reset-admin failed:', e.message);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  }
})();
