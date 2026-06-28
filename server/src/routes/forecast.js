const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope, audit } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
router.use(auth, loadScope);

// GET /api/forecast?from=&to=&branch=  -> forecast rows
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from/to richiesti' });
  const params = [from, to];
  let sql = `SELECT f.*, st.code AS service_code, st.name AS service_name, b.code AS branch_code
               FROM forecasts f
               JOIN service_types st ON st.id=f.service_type_id
               JOIN branches b ON b.id=f.branch_id
              WHERE f.forecast_date BETWEEN $1 AND $2`;
  if (!req.scope.admin) {
    if (!req.scope.branches.length) return res.json([]);
    params.push(req.scope.branches); sql += ` AND f.branch_id = ANY($${params.length})`;
  }
  if (req.query.branch) { params.push(req.query.branch); sql += ` AND b.code=$${params.length}`; }
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// PUT /api/forecast  { branch_id, service_type_id, forecast_date, qty }
router.put('/', requirePermission('forecast.manage'), async (req, res) => {
  const { branch_id, service_type_id, forecast_date, qty } = req.body || {};
  await pool.query(
    `INSERT INTO forecasts (branch_id, service_type_id, forecast_date, qty, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (branch_id, service_type_id, forecast_date)
     DO UPDATE SET qty=EXCLUDED.qty, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [branch_id, service_type_id, forecast_date, +qty || 0, req.user.username]);
  await audit(req, 'config', null, 'update', `Forecast ${forecast_date} = ${qty}`);
  res.json({ ok: true });
});

// GET /api/forecast/dashboard?from=&to=&branch=
// Returns forecast vs planned vs delta vs coverage% per service/day.
router.get('/dashboard', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from/to richiesti' });
  const branchFilter = req.query.branch ? ' AND b.code=$3' : '';
  const params = [from, to];
  if (req.query.branch) params.push(req.query.branch);

  // planned = count of schedules whose shift_code maps to a service's default_shift_code
  const sql = `
    WITH fc AS (
      SELECT f.branch_id, f.service_type_id, f.forecast_date AS d, sum(f.qty) qty
        FROM forecasts f JOIN branches b ON b.id=f.branch_id
       WHERE f.forecast_date BETWEEN $1 AND $2 ${branchFilter}
       GROUP BY 1,2,3),
    pl AS (
      SELECT e.branch_id, st.id AS service_type_id, s.work_date AS d, count(*) planned
        FROM schedules s
        JOIN employees e ON e.id=s.employee_id
        JOIN branches b ON b.id=e.branch_id
        JOIN service_types st ON st.default_shift_code = s.shift_code
       WHERE s.work_date BETWEEN $1 AND $2 ${branchFilter}
       GROUP BY 1,2,3)
    SELECT COALESCE(fc.branch_id,pl.branch_id) branch_id,
           COALESCE(fc.service_type_id,pl.service_type_id) service_type_id,
           st.name service_name, b.code branch_code,
           COALESCE(fc.d,pl.d) d,
           COALESCE(fc.qty,0) forecast, COALESCE(pl.planned,0) planned,
           COALESCE(pl.planned,0)-COALESCE(fc.qty,0) delta
      FROM fc FULL OUTER JOIN pl
        ON fc.branch_id=pl.branch_id AND fc.service_type_id=pl.service_type_id AND fc.d=pl.d
      LEFT JOIN service_types st ON st.id=COALESCE(fc.service_type_id,pl.service_type_id)
      LEFT JOIN branches b ON b.id=COALESCE(fc.branch_id,pl.branch_id)
     ORDER BY d, service_name`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

module.exports = router;
