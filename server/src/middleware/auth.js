const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db/pool');

const DEFAULT_SECRET = 'change-this-secret-in-.env';
const SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';

// (3) Strong JWT: require a >=64 char secret in production.
if (IS_PROD && (SECRET === DEFAULT_SECRET || SECRET.length < 64)) {
  console.error('FATAL: JWT_SECRET must be set to a strong value (>=64 chars) in production. Refusing to start.');
  console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
if (!IS_PROD && (SECRET === DEFAULT_SECRET || SECRET.length < 64)) {
  console.warn('[auth] WARNING: weak/default JWT secret. Set a 64+ char JWT_SECRET before deploying.');
}

const ACCESS_TTL  = process.env.JWT_TTL || '30m';        // (7) short-lived access token
const REFRESH_DAYS = +(process.env.REFRESH_DAYS || 7);   // refresh token lifetime

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- access token ----
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, full_name: user.full_name, typ: 'access' },
    SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

// ---- refresh token (opaque random, stored hashed in sessions) ----
async function issueRefreshToken(userId, req) {
  const raw = crypto.randomBytes(48).toString('hex');
  const expires = new Date(Date.now() + REFRESH_DAYS * 86400000);
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, sha256(raw), (req.headers['user-agent'] || '').slice(0, 300), req.ip, expires]
  );
  return raw;
}

// Rotate: validate an incoming refresh token, revoke it, issue a new one.
// Detects reuse: if a token hash is unknown or already revoked, we revoke ALL
// of the user's sessions (possible theft) and reject.
async function rotateRefreshToken(raw, req) {
  const hash = sha256(raw);
  const { rows } = await pool.query('SELECT * FROM sessions WHERE token_hash=$1', [hash]);
  const s = rows[0];
  if (!s) return { error: 'invalid' };
  if (s.revoked_at || new Date(s.expires_at) < new Date()) {
    // reuse / expired → revoke everything for that user as a precaution
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [s.user_id]);
    return { error: 'reuse' };
  }
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [s.id]);
  const userRes = await pool.query('SELECT * FROM users WHERE id=$1 AND active=TRUE', [s.user_id]);
  const user = userRes.rows[0];
  if (!user) return { error: 'invalid' };
  const newRaw = await issueRefreshToken(user.id, req);
  return { user, access: signToken(user), refresh: newRaw };
}

async function revokeRefreshToken(raw) {
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [sha256(raw)]);
}

// Verifies the bearer access token and attaches req.user
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  let tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok && req.query && req.query.token) tok = String(req.query.token); // file downloads
  if (!tok) return res.status(401).json({ error: 'Token mancante' });
  try {
    const payload = jwt.verify(tok, SECRET);
    if (payload.typ && payload.typ !== 'access') throw new Error('wrong token type');
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo Admin' });
  next();
}

// Branch/team scoping (unchanged): admins see all; others limited to assignments.
async function loadScope(req, res, next) {
  try {
    if (req.user.role === 'admin') {
      req.scope = { admin: true, branches: null, teams: null };
      return next();
    }
    const b = await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1', [req.user.id]);
    const t = await pool.query('SELECT team_id FROM user_teams WHERE user_id=$1', [req.user.id]);
    req.scope = { admin: false, branches: b.rows.map((r) => r.branch_id), teams: t.rows.map((r) => r.team_id) };
    next();
  } catch (e) {
    next(e);
  }
}

// (6) Audit helper
async function audit(req, entity, entityId, action, detail) {
  try {
    await pool.query(
      `INSERT INTO audit_log (username, role, entity, entity_id, action, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user?.username || (req.auditUser || null), req.user?.role || null, entity,
       entityId == null ? null : String(entityId), action, detail || null, req.ip]
    );
  } catch (e) {
    console.error('audit failed:', e.message);
  }
}

// ---- (4) login lockout helpers (DB-backed) ----
const LOCK_WINDOW_MIN = +(process.env.LOCK_WINDOW_MIN || 15);
const LOCK_MAX_FAILS  = +(process.env.LOCK_MAX_FAILS || 5);

async function isLocked(username, ip) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE success=FALSE AND at > now() - ($1||' minutes')::interval
        AND (lower(username)=lower($2) OR ip=$3)`,
    [String(LOCK_WINDOW_MIN), username || '', ip || '']
  );
  return rows[0].n >= LOCK_MAX_FAILS;
}
async function recordAttempt(username, ip, success) {
  await pool.query('INSERT INTO login_attempts (username, ip, success) VALUES ($1,$2,$3)', [username || null, ip || null, success]);
}

module.exports = {
  signToken, auth, requireAdmin, loadScope, audit, SECRET,
  issueRefreshToken, rotateRefreshToken, revokeRefreshToken,
  isLocked, recordAttempt, sha256, LOCK_MAX_FAILS, LOCK_WINDOW_MIN,
};
