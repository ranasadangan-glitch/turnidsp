const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope, audit } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
router.use(auth, loadScope);

router.get('/', async (req, res) => {
  const params = [];
  let sql = `SELECT a.*, e.first_name, e.last_name, e.branch_id
               FROM absences a JOIN employees e ON e.id=a.employee_id WHERE 1=1`;
  if (!req.scope.admin) {
    if (!req.scope.branches.length) return res.json([]);
    params.push(req.scope.branches); sql += ` AND e.branch_id = ANY($${params.length})`;
  }
  if (req.query.employee_id) { params.push(req.query.employee_id); sql += ` AND a.employee_id=$${params.length}`; }
  sql += ' ORDER BY a.start_date DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.post('/', requirePermission('absence.manage'), async (req, res) => {
  const { employee_id, absence_type, start_date, end_date, note } = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO absences (employee_id,absence_type,start_date,end_date,note,created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [employee_id, absence_type, start_date, end_date, note || null, req.user.username]);
  await audit(req, 'absence', rows[0].id, 'create', `${absence_type} ${start_date}→${end_date}`);
  res.status(201).json(rows[0]);
});

router.delete('/:id', requirePermission('absence.manage'), async (req, res) => {
  await pool.query('DELETE FROM absences WHERE id=$1', [req.params.id]);
  await audit(req, 'absence', req.params.id, 'delete', 'Assenza rimossa');
  res.json({ ok: true });
});

module.exports = router;
