const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
router.use(auth, loadScope, requirePermission('report.view'));

function branchClause(scope, params, col='e.branch_id'){
  if (scope.admin) return '';
  if (!scope.branches.length) return ' AND 1=0';
  params.push(scope.branches); return ` AND ${col} = ANY($${params.length})`;
}

// GET /api/reports/summary?from=&to=
router.get('/summary', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from/to richiesti' });
  const p1=[from,to]; const bc=branchClause(req.scope,p1);

  // planned hours = worked shift days * (weekly_hours/working-days-per-week ~ approx using contract weekly hours/5)
  const planned = await pool.query(
    `SELECT count(*) FILTER (WHERE sc.is_work) AS worked_days,
            count(*) FILTER (WHERE sc.is_absence) AS absence_days,
            count(*) FILTER (WHERE sc.is_off) AS off_days
       FROM schedules s
       JOIN employees e ON e.id=s.employee_id
       JOIN shift_codes sc ON sc.code=s.shift_code
      WHERE s.work_date BETWEEN $1 AND $2 ${bc}`, p1);

  const p2=[]; const bc2=branchClause(req.scope,p2);
  const contracted = await pool.query(
    `SELECT COALESCE(sum(e.weekly_hours),0) AS total_weekly_hours, count(*) AS active_employees
       FROM employees e WHERE e.status='active' ${bc2}`, p2);

  const byBranch = await pool.query(
    `SELECT b.code, count(e.*) FILTER (WHERE e.status='active') AS active
       FROM branches b LEFT JOIN employees e ON e.branch_id=b.id
      GROUP BY b.code ORDER BY b.code`);

  const wd = +planned.rows[0].worked_days, ab = +planned.rows[0].absence_days;
  const absenceRate = (wd+ab) ? +(ab/(wd+ab)*100).toFixed(1) : 0;

  res.json({
    period: { from, to },
    worked_days: wd, absence_days: ab, off_days: +planned.rows[0].off_days,
    absence_rate_pct: absenceRate,
    contracted_weekly_hours: +contracted.rows[0].total_weekly_hours,
    active_employees: +contracted.rows[0].active_employees,
    by_branch: byBranch.rows,
  });
});

// GET /api/reports/forecast-accuracy?from=&to=
router.get('/forecast-accuracy', async (req, res) => {
  const { from, to } = req.query;
  const { rows } = await pool.query(
    `WITH fc AS (SELECT forecast_date d, sum(qty) f FROM forecasts WHERE forecast_date BETWEEN $1 AND $2 GROUP BY 1),
          pl AS (SELECT s.work_date d, count(*) p FROM schedules s JOIN shift_codes sc ON sc.code=s.shift_code
                  WHERE sc.is_work AND s.work_date BETWEEN $1 AND $2 GROUP BY 1)
     SELECT COALESCE(fc.d,pl.d) d, COALESCE(fc.f,0) forecast, COALESCE(pl.p,0) planned,
            COALESCE(pl.p,0)-COALESCE(fc.f,0) delta
       FROM fc FULL OUTER JOIN pl ON fc.d=pl.d ORDER BY d`, [from, to]);
  const tot = rows.reduce((a,r)=>{a.f+=+r.forecast;a.p+=+r.planned;a.err+=Math.abs(+r.delta);return a;},{f:0,p:0,err:0});
  const accuracy = tot.f ? +(100 - (tot.err/tot.f*100)).toFixed(1) : null;
  res.json({ rows, totals: tot, accuracy_pct: accuracy });
});

// GET /api/reports/dsp-dashboard?date=YYYY-MM-DD&branch=
// Single aggregated snapshot for the operations dashboard.
router.get('/dsp-dashboard', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  // forecast vs planned for the day (per service), scoped
  const p1 = [date]; const bc1 = branchClause(req.scope, p1, 'e.branch_id');
  const pf = [date]; const bcf = branchClause(req.scope, pf, 'f.branch_id');
  if (req.query.branch) { p1.push(req.query.branch); pf.push(req.query.branch); }
  const brEmp = req.query.branch ? ` AND b.code=$${p1.length}` : '';
  const brFc  = req.query.branch ? ` AND b.code=$${pf.length}` : '';

  const planned = await pool.query(
    `SELECT st.name service, count(*)::int planned
       FROM schedules s
       JOIN employees e ON e.id=s.employee_id
       JOIN branches b ON b.id=e.branch_id
       JOIN service_types st ON st.default_shift_code=s.shift_code
      WHERE s.work_date=$1 ${bc1} ${brEmp}
      GROUP BY st.name`, p1);
  const forecast = await pool.query(
    `SELECT st.name service, sum(f.qty)::int qty
       FROM forecasts f
       JOIN branches b ON b.id=f.branch_id
       JOIN service_types st ON st.id=f.service_type_id
      WHERE f.forecast_date=$1 ${bcf} ${brFc}
      GROUP BY st.name`, pf);

  const fMap = {}; forecast.rows.forEach(r => fMap[r.service] = r.qty);
  const pMap = {}; planned.rows.forEach(r => pMap[r.service] = r.planned);
  const services = [...new Set([...Object.keys(fMap), ...Object.keys(pMap)])];
  const byService = services.map(s => {
    const f = fMap[s] || 0, p = pMap[s] || 0;
    return { service: s, forecast: f, planned: p, delta: p - f, coverage_pct: f ? Math.round(p / f * 100) : null };
  });
  const totF = byService.reduce((a, x) => a + x.forecast, 0);
  const totP = byService.reduce((a, x) => a + x.planned, 0);

  // active drivers (scoped)
  const pa = []; const bca = branchClause(req.scope, pa, 'branch_id');
  let activeSql = `SELECT count(*)::int n FROM employees WHERE status='active' ${bca}`;
  if (req.query.branch) { pa.push(req.query.branch); activeSql += ` AND branch_id=(SELECT id FROM branches WHERE code=$${pa.length})`; }
  const active = await pool.query(activeSql, pa);

  // absent today: schedule code is an absence OR an open absence record covers the date
  const pab = [date]; const bcab = branchClause(req.scope, pab, 'e.branch_id');
  const absent = await pool.query(
    `SELECT count(DISTINCT e.id)::int n
       FROM employees e
       LEFT JOIN schedules s ON s.employee_id=e.id AND s.work_date=$1
       LEFT JOIN shift_codes sc ON sc.code=s.shift_code
       LEFT JOIN absences a ON a.employee_id=e.id AND $1 BETWEEN a.start_date AND a.end_date
      WHERE e.status='active' AND (sc.is_absence=TRUE OR a.id IS NOT NULL) ${bcab}`, pab);

  // open disciplinary cases (scoped)
  const pd = []; const bcd = branchClause(req.scope, pd, 'e.branch_id');
  const disc = await pool.query(
    `SELECT count(*)::int n FROM disciplinary_actions d
       JOIN employees e ON e.id=d.employee_id
      WHERE d.archived=FALSE ${bcd}`, pd);

  res.json({
    date,
    totals: { forecast: totF, planned: totP, delta: totP - totF, coverage_pct: totF ? Math.round(totP / totF * 100) : null },
    by_service: byService,
    active_drivers: active.rows[0].n,
    absent_drivers: absent.rows[0].n,
    open_disciplinary: disc.rows[0].n,
  });
});

module.exports = router;
