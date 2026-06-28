const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, requireAdmin, loadScope, audit } = require('../middleware/auth');
router.use(auth, loadScope);

// GET /api/teams  (with employee counts and leader)
router.get('/', async (req, res) => {
  const params = [];
  let sql = `SELECT t.*, b.code AS branch_code, u.full_name AS leader_name,
                    (SELECT count(*) FROM employees e WHERE e.team_id=t.id AND e.status='active') AS employee_count
               FROM teams t
               LEFT JOIN branches b ON b.id=t.branch_id
               LEFT JOIN users u ON u.id=t.team_leader_id
              WHERE 1=1`;
  if (!req.scope.admin) {
    if (!req.scope.teams.length) return res.json([]);
    params.push(req.scope.teams); sql += ` AND t.id = ANY($${params.length})`;
  }
  sql += ' ORDER BY b.code, t.name';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// GET /api/teams/:id/stats
router.get('/:id/stats', async (req, res) => {
  const id = req.params.id;
  const emp = await pool.query("SELECT status, count(*) FROM employees WHERE team_id=$1 GROUP BY status", [id]);
  const bySvc = await pool.query(
    `SELECT st.name, count(*) FROM employees e LEFT JOIN service_types st ON st.id=e.service_type_id
      WHERE e.team_id=$1 AND e.status='active' GROUP BY st.name`, [id]);
  res.json({ by_status: emp.rows, by_service: bySvc.rows });
});

// POST /api/teams  (admin)
router.post('/', requireAdmin, async (req, res) => {
  const { branch_id, name, team_leader_id } = req.body || {};
  const { rows } = await pool.query(
    'INSERT INTO teams (branch_id,name,team_leader_id) VALUES ($1,$2,$3) RETURNING *',
    [branch_id, name, team_leader_id || null]);
  await audit(req, 'config', rows[0].id, 'create', 'Team: ' + name);
  res.status(201).json(rows[0]);
});

// PUT /api/teams/:id  (admin) — assign leader / rename
router.put('/:id', requireAdmin, async (req, res) => {
  const { name, team_leader_id } = req.body || {};
  const { rows } = await pool.query(
    'UPDATE teams SET name=COALESCE($1,name), team_leader_id=$2 WHERE id=$3 RETURNING *',
    [name || null, team_leader_id || null, req.params.id]);
  await audit(req, 'config', req.params.id, 'update', 'Team aggiornato');
  res.json(rows[0]);
});

module.exports = router;
