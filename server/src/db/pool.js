const { Pool } = require('pg');
require('dotenv').config();

// ── Connection configuration ───────────────────────────────────────────────
// Managed hosts (Render, Railway, Heroku, Supabase, …) provide a single
// DATABASE_URL and REQUIRE SSL. We read DATABASE_URL from the environment and
// enable SSL automatically when it is present.
//
// SSL rules:
//   • DATABASE_URL present  -> SSL on by default ({ rejectUnauthorized: false })
//   • PGSSL=true            -> force SSL on
//   • PGSSL=false           -> force SSL off (e.g. local Postgres / private nets
//                              that don't terminate TLS)
//   • no DATABASE_URL       -> discrete PG* vars, SSL off unless PGSSL=true
// Render's managed PostgreSQL terminates TLS, so SSL must be enabled there.
const hasUrl = !!process.env.DATABASE_URL;

function resolveSsl() {
  if (process.env.PGSSL === 'true') return { rejectUnauthorized: false };
  if (process.env.PGSSL === 'false') return false;
  // default: require SSL whenever we connect via a managed DATABASE_URL
  return hasUrl ? { rejectUnauthorized: false } : false;
}

const ssl = resolveSsl();
const max = +(process.env.PG_POOL_MAX || 20);
const idleTimeoutMillis = 30000;
const connectionTimeoutMillis = +(process.env.PG_CONNECT_TIMEOUT || 10000);

const config = hasUrl
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl,
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
    }
  : {
      host: process.env.PGHOST || 'localhost',
      port: +(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'turnidsp',
      password: process.env.PGPASSWORD || 'turnidsp',
      database: process.env.PGDATABASE || 'turnidsp',
      ssl,
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
    };

const pool = new Pool(config);

pool.on('error', (err) => console.error('PG pool error:', err.message));

// Log the effective mode once at startup (no secrets).
console.log(
  `[db] mode=${hasUrl ? 'DATABASE_URL' : 'PG* vars'} ssl=${ssl ? 'on' : 'off'} poolMax=${max}`
);

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  // helper for a transaction
  withTx: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
};
