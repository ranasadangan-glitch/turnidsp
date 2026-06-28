// Reference data: branches, service types, shift codes, contract types, users (admin)
const router = require('express').Router();
const { pool } = require('../db/pool');
const bcrypt = require('bcryptjs');
const { auth, requireAdmin, loadScope, audit } = require('../middleware/auth');
router.use(auth, loadScope);

router.get('/branches', async (_req, res) => res.json((await pool.query('SELECT * FROM branches ORDER BY code')).rows));
router.get('/service-types', async (_req, res) => res.json((await pool.query('SELECT * FROM service_types WHERE active ORDER BY sort_order')).rows));
router.get('/shift-codes', async (_req, res) => res.json((await pool.query('SELECT * FROM shift_codes ORDER BY category, code')).rows));
router.get('/contract-types', async (_req, res) => res.json((await pool.query('SELECT * FROM contract_types ORDER BY code')).rows));
router.get('/parking/:branchId', async (req,res)=> res.json((await pool.query('SELECT * FROM parking_points WHERE branch_id=$1',[req.params.branchId])).rows));

// ---- users management (admin) ----
router.get('/users', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT id,username,full_name,role,active,last_login FROM users ORDER BY username');
  res.json(rows);
});
router.post('/users', requireAdmin, async (req, res) => {
  try {
    let { username, password, full_name, role, branch_ids, team_ids } = req.body || {};
    username = (username || '').trim().toLowerCase();   // normalize so login always matches
    if (!username || !password) return res.status(400).json({ error: 'Username e password sono obbligatori' });
    if (String(password).length < 6) return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri' });
    const dup = await pool.query('SELECT 1 FROM users WHERE lower(username)=$1', [username]);
    if (dup.rowCount) return res.status(409).json({ error: 'Username già esistente' });
    const ROLES = ['admin','osm','hr_manager','team_leader'];
    const safeRole = ROLES.includes(role) ? role : 'team_leader';
    const { rows } = await pool.query(
      'INSERT INTO users (username,password_hash,full_name,role,active) VALUES ($1,$2,$3,$4,TRUE) RETURNING id,username,role',
      [username, bcrypt.hashSync(password, 10), full_name || null, safeRole]);
    for (const b of (branch_ids||[])) await pool.query('INSERT INTO user_branches (user_id,branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, b]);
    for (const t of (team_ids||[])) await pool.query('INSERT INTO user_teams (user_id,team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, t]);
    await audit(req, 'user', rows[0].id, 'create', 'Utente: ' + username);
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('create user error:', e.message);
    res.status(500).json({ error: 'Errore creazione utente' });
  }
});
router.patch('/users/:id', requireAdmin, async (req, res) => {
  const { active, password, full_name, branch_ids, team_ids } = req.body || {};
  if (active !== undefined) await pool.query('UPDATE users SET active=$1 WHERE id=$2', [active, req.params.id]);
  if (password) {
    const { passwordIssues } = require('./password');
    const issues = passwordIssues(password);
    if (issues.length) return res.status(400).json({ error: 'La password deve contenere: ' + issues.join(', ') });
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(password,10), req.params.id]);
    // Invalidate the target user's existing sessions, same as the self-service reset flow.
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [req.params.id]);
  }
  if (full_name !== undefined) await pool.query('UPDATE users SET full_name=$1 WHERE id=$2', [full_name, req.params.id]);
  if (branch_ids) { await pool.query('DELETE FROM user_branches WHERE user_id=$1',[req.params.id]);
    for (const b of branch_ids) await pool.query('INSERT INTO user_branches (user_id,branch_id) VALUES ($1,$2)',[req.params.id,b]); }
  if (team_ids) { await pool.query('DELETE FROM user_teams WHERE user_id=$1',[req.params.id]);
    for (const t of team_ids) await pool.query('INSERT INTO user_teams (user_id,team_id) VALUES ($1,$2)',[req.params.id,t]); }
  await audit(req, 'user', req.params.id, 'update', password ? 'Password reimpostata dall’admin' : 'Utente aggiornato');
  res.json({ ok: true });
});

module.exports = router;
