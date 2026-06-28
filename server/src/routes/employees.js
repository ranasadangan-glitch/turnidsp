const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope, audit } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(auth, loadScope);

// Builds a WHERE clause restricting to the user's branches (admins: no restriction)
function scopeWhere(scope, params, col = 'e.branch_id') {
  if (scope.admin) return '';
  if (!scope.branches.length) return ' AND 1=0';
  params.push(scope.branches);
  return ` AND ${col} = ANY($${params.length})`;
}

// GET /api/employees?branch=&team=&status=&q=&page=&pageSize=
// Returns { rows, total, page, pageSize } when paginated; plain array otherwise (back-compat).
router.get('/', async (req, res) => {
  const params = [];
  let where = ' WHERE 1=1';
  where += scopeWhere(req.scope, params);
  if (req.query.branch) { params.push(req.query.branch); where += ` AND b.code=$${params.length}`; }
  if (req.query.team)   { params.push(+req.query.team);  where += ` AND e.team_id=$${params.length}`; }
  if (req.query.status) { params.push(req.query.status); where += ` AND e.status=$${params.length}`; }
  if (req.query.q)      { params.push('%' + req.query.q.toLowerCase() + '%');
                          where += ` AND (lower(e.first_name||' '||e.last_name) LIKE $${params.length}
                                       OR lower(COALESCE(e.employee_code,'')) LIKE $${params.length}
                                       OR lower(COALESCE(e.transporter_id,'')) LIKE $${params.length})`; }
  const base = `FROM employees e
                LEFT JOIN branches b ON b.id=e.branch_id
                LEFT JOIN teams t ON t.id=e.team_id
                LEFT JOIN service_types st ON st.id=e.service_type_id
                LEFT JOIN contract_types ct ON ct.id=e.contract_type_id` + where;

  const paginate = req.query.page !== undefined || req.query.pageSize !== undefined;
  let sql = `SELECT e.*, b.code AS branch_code, t.name AS team_name,
                    st.name AS service_name, ct.label AS contract_label ` + base +
            ' ORDER BY e.last_name, e.first_name';
  if (paginate) {
    const page = Math.max(1, +(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(1, +(req.query.pageSize || 50)));
    const totalRes = await pool.query(`SELECT count(*)::int AS n ` + base, params);
    params.push(pageSize); params.push((page - 1) * pageSize);
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(sql, params);
    return res.json({ rows, total: totalRes.rows[0].n, page, pageSize });
  }
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

const FIELDS = ['employee_code','transporter_id','first_name','last_name','email','phone','device',
  'branch_id','team_id','service_type_id','contract_type_id','weekly_hours','default_shift_code',
  'work_days','hire_date','contract_start_date','contract_end_date','status',
  'emergency_name','emergency_phone','notes','photo_url','nationality','tax_code'];

// GET /api/employees/:id — single employee with full profile
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              (SELECT json_agg(a ORDER BY a.start_date DESC) FROM absences a WHERE a.employee_id = p.id) AS absences,
              (SELECT json_agg(d ORDER BY d.created_at DESC) FROM documents d WHERE d.employee_id = p.id) AS documents,
              (SELECT json_agg(disc ORDER BY disc.action_date DESC)
                 FROM disciplinary_actions disc WHERE disc.employee_id = p.id AND disc.archived = FALSE) AS disciplinary,
              (SELECT json_agg(
                  json_build_object('work_date', s.work_date, 'shift_code', s.shift_code, 'note', s.note)
                  ORDER BY s.work_date DESC
               ) FROM (SELECT * FROM schedules WHERE employee_id = p.id ORDER BY work_date DESC LIMIT 60) s
              ) AS recent_schedules
         FROM v_employee_profile p
        WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Non trovato' });
    res.json(rows[0]);
  } catch (e) {
    console.error('employee profile:', e.message);
    res.status(500).json({ error: 'Errore profilo' });
  }
});

// POST /api/employees  (admin)
router.post('/', requirePermission('employee.manage'), async (req, res) => {
  const b = req.body || {};
  const cols = FIELDS.filter((f) => b[f] !== undefined);
  const vals = cols.map((f) => b[f]);
  const ph = cols.map((_, i) => '$' + (i + 1));
  const { rows } = await pool.query(
    `INSERT INTO employees (${cols.join(',')}, added_by) VALUES (${ph.join(',')}, $${cols.length + 1}) RETURNING *`,
    [...vals, req.user.username]
  );
  await audit(req, 'employee', rows[0].id, 'create', `${rows[0].first_name} ${rows[0].last_name}`);
  res.status(201).json(rows[0]);
});

// PUT /api/employees/:id  (admin)
router.put('/:id', requirePermission('employee.manage'), async (req, res) => {
  const b = req.body || {};
  const cols = FIELDS.filter((f) => b[f] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'Nessun campo' });
  const sets = cols.map((f, i) => `${f}=$${i + 1}`);
  const { rows } = await pool.query(
    `UPDATE employees SET ${sets.join(',')} WHERE id=$${cols.length + 1} RETURNING *`,
    [...cols.map((f) => b[f]), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Non trovato' });
  await audit(req, 'employee', req.params.id, 'update', `${rows[0].first_name} ${rows[0].last_name}`);
  res.json(rows[0]);
});

// PATCH /api/employees/:id/status  { status }  (admin) — disable instead of delete
router.patch('/:id/status', requirePermission('employee.manage'), async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'status non valido' });
  const { rows } = await pool.query('UPDATE employees SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Non trovato' });
  await audit(req, 'employee', req.params.id, 'update', 'Stato → ' + status);
  res.json(rows[0]);
});

// POST /api/employees/import  { rows:[{...}] }  (admin) — bulk import
router.post('/import', requirePermission('employee.manage'), async (req, res) => {
  const list = (req.body && req.body.rows) || [];
  let added = 0;
  for (const b of list) {
    const cols = FIELDS.filter((f) => b[f] !== undefined);
    if (!b.first_name && !b.last_name) continue;
    const ph = cols.map((_, i) => '$' + (i + 1));
    await pool.query(
      `INSERT INTO employees (${cols.join(',')}, added_by) VALUES (${ph.join(',')}, $${cols.length + 1})`,
      [...cols.map((f) => b[f]), req.user.username]
    );
    added++;
  }
  await audit(req, 'employee', null, 'create', `Import ${added} dipendenti`);
  res.json({ added });
});

module.exports = router;
