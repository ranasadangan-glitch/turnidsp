// (8) Password reset: expiring single-use tokens + complexity rules.
// Email delivery is sent via SMTP when configured (nodemailer); otherwise, in
// non-production the reset link/token is returned in the response and logged so
// the flow is testable without a mail server. We never reveal whether an account
// exists (anti-enumeration).
const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/pool');
const { audit, sha256 } = require('../middleware/auth');

const RESET_TTL_MIN = +(process.env.RESET_TTL_MIN || 30);
const IS_PROD = process.env.NODE_ENV === 'production';

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// Password complexity: >=10 chars, upper, lower, digit.
function passwordIssues(pw) {
  const errs = [];
  if (!pw || pw.length < 10) errs.push('almeno 10 caratteri');
  if (!/[A-Z]/.test(pw)) errs.push('una maiuscola');
  if (!/[a-z]/.test(pw)) errs.push('una minuscola');
  if (!/[0-9]/.test(pw)) errs.push('un numero');
  return errs;
}

async function sendMail(to, subject, text) {
  // Only attempt real delivery if SMTP is configured.
  if (!process.env.SMTP_HOST) return { sent: false, reason: 'SMTP not configured' };
  try {
    const nodemailer = require('nodemailer'); // optional dependency
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await t.sendMail({ from: process.env.SMTP_FROM || 'no-reply@gestioneturni', to, subject, text });
    return { sent: true };
  } catch (e) {
    console.error('sendMail failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

// POST /api/password/forgot  { username }  (or email)
router.post('/forgot', limiter, async (req, res) => {
  try {
    const id = (req.body && (req.body.username || req.body.email) || '').trim();
    if (!id) return res.status(400).json({ error: 'Username o email richiesti' });
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)', [id]);
    const u = rows[0];
    // Always respond the same way (no account enumeration).
    const generic = { ok: true, message: 'Se l’account esiste, sono state inviate le istruzioni per il reset.' };
    if (!u || !u.active) return res.json(generic);

    const raw = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + RESET_TTL_MIN * 60000);
    await pool.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
      [u.id, sha256(raw), expires]);

    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${base}/login.html?reset=${raw}`;
    const mail = await sendMail(u.email, 'Reset password — Gestione Turni',
      `Reimposta la password entro ${RESET_TTL_MIN} minuti: ${link}`);

    await audit({ user: u, ip: req.ip }, 'user', u.id, 'update', 'Richiesta reset password');
    // In non-prod (or if no SMTP), surface the token so the flow is testable.
    if (!mail.sent && !IS_PROD) return res.json({ ...generic, dev_token: raw, dev_link: link });
    return res.json(generic);
  } catch (e) {
    console.error('forgot error:', e.message);
    res.json({ ok: true, message: 'Se l’account esiste, sono state inviate le istruzioni per il reset.' });
  }
});

// POST /api/password/reset  { token, password }
router.post('/reset', limiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token e nuova password richiesti' });
    const issues = passwordIssues(password);
    if (issues.length) return res.status(400).json({ error: 'La password deve contenere: ' + issues.join(', ') });

    const { rows } = await pool.query('SELECT * FROM password_reset_tokens WHERE token_hash=$1', [sha256(token)]);
    const t = rows[0];
    if (!t || t.used_at || new Date(t.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token non valido o scaduto' });
    }
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(password, 10), t.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used_at=now() WHERE id=$1', [t.id]);
    // Invalidate all existing sessions for safety.
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [t.user_id]);
    await audit({ user: { id: t.user_id }, ip: req.ip }, 'user', t.user_id, 'update', 'Password reimpostata');
    res.json({ ok: true, message: 'Password aggiornata. Effettua l’accesso.' });
  } catch (e) {
    console.error('reset error:', e.message);
    res.status(503).json({ error: 'Servizio non disponibile' });
  }
});

module.exports = { router, passwordIssues };
