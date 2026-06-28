// GET /api/kpi?date=YYYY-MM-DD&branch=CODE
// Returns all KPI data for the control-centre dashboard in a single round-trip.
// Every query is independently try/catched so a missing table never kills the page.

const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope } = require('../middleware/auth');

router.use(auth, loadScope);

function branchClauses(scope, params, col = 'e.branch_id') {
  if (scope.admin) return '';
  if (!scope.branches.length) return ' AND 1=0';
  params.push(scope.branches);
  return ` AND ${col} = ANY($${params.length})`;
}

async function safe(fn) {
  try { return await fn(); } catch (e) { console.error('KPI error:', e.message); return null; }
}

router.get('/', async (req, res) => {
  const date  = req.query.date   || new Date().toISOString().slice(0, 10);
  const branch = req.query.branch || null;

  const result = {};

  // ── Drivers today ─────────────────────────────────────────────────────────
  result.drivers = await safe(async () => {
    const p = [date]; const bc = branchClauses(req.scope, p);
    const brC = branch ? (p.push(branch), ` AND b.code=$${p.length}`) : '';
    const r = await pool.query(
      `SELECT
         count(e.id) FILTER (WHERE e.status='active')::int AS total,
         count(s.employee_id) FILTER (WHERE sc.is_work AND s.work_date=$1)::int AS present,
         count(s.employee_id) FILTER (WHERE sc.is_absence AND s.work_date=$1)::int AS absent,
         count(a.id) FILTER (WHERE a.absence_type='medical_leave' AND $1 BETWEEN a.start_date AND a.end_date)::int AS on_leave
       FROM employees e
       LEFT JOIN branches b ON b.id=e.branch_id
       LEFT JOIN schedules s ON s.employee_id=e.id AND s.work_date=$1
       LEFT JOIN shift_codes sc ON sc.code=s.shift_code
       LEFT JOIN absences a ON a.employee_id=e.id
       WHERE 1=1 ${bc} ${brC}`, p);
    const row = r.rows[0] || {};
    return {
      total:    row.total    || 0,
      present:  row.present  || 0,
      absent:   row.absent   || 0,
      on_leave: row.on_leave || 0,
      late: 0, // requires a clock-in system — placeholder
    };
  });

  // ── Forecast vs Planned ────────────────────────────────────────────────────
  result.forecast = await safe(async () => {
    const pf = [date]; const brFc = branch ? (pf.push(branch), ` AND b.code=$${pf.length}`) : '';
    const pe = [date]; const brEmp = branch ? (pe.push(branch), ` AND b.code=$${pe.length}`) : '';
    const bcFc  = branchClauses(req.scope, pf,  'f.branch_id');
    const bcEmp = branchClauses(req.scope, pe, 'e.branch_id');

    const [fcR, plR] = await Promise.all([
      pool.query(`SELECT COALESCE(sum(f.qty),0)::int AS qty FROM forecasts f JOIN branches b ON b.id=f.branch_id WHERE f.forecast_date=$1 ${bcFc} ${brFc}`, pf),
      pool.query(`SELECT count(*)::int AS cnt FROM schedules s JOIN employees e ON e.id=s.employee_id JOIN shift_codes sc ON sc.code=s.shift_code JOIN branches b ON b.id=e.branch_id WHERE s.work_date=$1 AND sc.is_work ${bcEmp} ${brEmp}`, pe),
    ]);
    const f = fcR.rows[0]?.qty || 0;
    const p = plR.rows[0]?.cnt || 0;
    const delta = p - f;
    return { forecast: f, planned: p, delta, delta_pct: f ? Math.round(delta / f * 100) : 0 };
  });

  // ── Attendance breakdown (today) ───────────────────────────────────────────
  result.attendance = await safe(async () => {
    const p = [date]; const bc = branchClauses(req.scope, p);
    const brC = branch ? (p.push(branch), ` AND b.code=$${p.length}`) : '';
    const r = await pool.query(
      `SELECT sc.code, sc.is_work, sc.is_absence, sc.is_off, sc.category, count(*)::int AS cnt
         FROM schedules s
         JOIN employees e ON e.id=s.employee_id
         JOIN branches b ON b.id=e.branch_id
         JOIN shift_codes sc ON sc.code=s.shift_code
        WHERE s.work_date=$1 ${bc} ${brC}
        GROUP BY sc.code, sc.is_work, sc.is_absence, sc.is_off, sc.category`, p);
    const out = { present: 0, absent: 0, medical: 0, vacation: 0, training: 0, half_day: 0, other: 0 };
    for (const row of r.rows) {
      if (row.is_work)    out.present  += row.cnt;
      if (row.is_off)     out.vacation += row.cnt;
      if (row.is_absence) {
        if (/mal|medical/i.test(row.category || '')) out.medical += row.cnt;
        else if (/form|train/i.test(row.category || '')) out.training += row.cnt;
        else out.absent += row.cnt;
      }
    }
    return out;
  });

  // ── Contracts expiring ─────────────────────────────────────────────────────
  result.contracts = await safe(async () => {
    const p = [date]; const bc = branchClauses(req.scope, p);
    const brC = branch ? (p.push(branch), ` AND b.code=$${p.length}`) : '';
    const r = await pool.query(
      `SELECT
        count(*) FILTER (WHERE contract_end_date < $1::date)::int AS expired,
        count(*) FILTER (WHERE contract_end_date BETWEEN $1::date AND $1::date + 7)::int AS in_7,
        count(*) FILTER (WHERE contract_end_date BETWEEN $1::date AND $1::date + 15)::int AS in_15,
        count(*) FILTER (WHERE contract_end_date BETWEEN $1::date AND $1::date + 30)::int AS in_30
       FROM employees e LEFT JOIN branches b ON b.id=e.branch_id
       WHERE e.status='active' AND e.contract_end_date IS NOT NULL ${bc} ${brC}`, p);
    return r.rows[0] || { expired: 0, in_7: 0, in_15: 0, in_30: 0 };
  });

  // ── Attendance trend (last 30 days) ───────────────────────────────────────
  result.attendance_trend = await safe(async () => {
    const p = [date]; const bc = branchClauses(req.scope, p);
    const brC = branch ? (p.push(branch), ` AND b.code=$${p.length}`) : '';
    const r = await pool.query(
      `SELECT s.work_date::text AS d,
              count(*) FILTER (WHERE sc.is_work)::int AS present,
              count(*) FILTER (WHERE sc.is_absence)::int AS absent
         FROM schedules s
         JOIN employees e ON e.id=s.employee_id
         JOIN branches b ON b.id=e.branch_id
         JOIN shift_codes sc ON sc.code=s.shift_code
        WHERE s.work_date BETWEEN ($1::date - 29) AND $1::date ${bc} ${brC}
        GROUP BY s.work_date ORDER BY s.work_date`, p);
    return r.rows;
  });

  // ── Forecast accuracy trend ────────────────────────────────────────────────
  result.forecast_trend = await safe(async () => {
    const p = [date]; const bc = branchClauses(req.scope, p, 'e.branch_id');
    const brC = branch ? (p.push(branch), ` AND b.code=$${p.length}`) : '';
    const r = await pool.query(
      `WITH fc AS (
        SELECT f.forecast_date d, sum(f.qty) f
          FROM forecasts f JOIN branches b ON b.id=f.branch_id
         WHERE f.forecast_date BETWEEN ($1::date - 29) AND $1::date ${brC}
         GROUP BY 1),
       pl AS (
        SELECT s.work_date d, count(*) p
          FROM schedules s JOIN employees e ON e.id=s.employee_id
          JOIN branches b ON b.id=e.branch_id
          JOIN shift_codes sc ON sc.code=s.shift_code
         WHERE sc.is_work AND s.work_date BETWEEN ($1::date - 29) AND $1::date ${bc} ${brC}
         GROUP BY 1)
       SELECT COALESCE(fc.d,pl.d)::text AS d, COALESCE(fc.f,0)::int AS forecast, COALESCE(pl.p,0)::int AS planned
         FROM fc FULL OUTER JOIN pl ON fc.d=pl.d ORDER BY d`, p);
    return r.rows;
  });

  // ── Recent activity (from audit_log) ──────────────────────────────────────
  result.activity = await safe(async () => {
    const r = await pool.query(
      `SELECT username, role, entity, action, detail, ts
         FROM audit_log ORDER BY ts DESC LIMIT 20`);
    return r.rows;
  });

  // ── Employee growth (monthly) ─────────────────────────────────────────────
  result.employee_growth = await safe(async () => {
    const p = []; const bc = branchClauses(req.scope, p);
    const brC = branch ? (p.push(branch), ` AND b.code=$${p.length}`) : '';
    const r = await pool.query(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, count(*)::int AS added
         FROM employees e LEFT JOIN branches b ON b.id=e.branch_id
         WHERE created_at >= now() - interval '12 months' ${bc} ${brC}
         GROUP BY 1 ORDER BY 1`, p);
    return r.rows;
  });

  // ── Absence type distribution ──────────────────────────────────────────────
  result.absence_types = await safe(async () => {
    const p = []; const bc = branchClauses(req.scope, p, 'e.branch_id');
    const brC = branch ? (p.push(branch), ` AND b.code=$${p.length}`) : '';
    const r = await pool.query(
      `SELECT absence_type, count(*)::int AS cnt
         FROM absences a JOIN employees e ON e.id=a.employee_id
         LEFT JOIN branches b ON b.id=e.branch_id
         WHERE a.start_date >= now() - interval '90 days' ${bc} ${brC}
         GROUP BY 1 ORDER BY cnt DESC LIMIT 8`, p);
    return r.rows;
  });

  res.json({ date, ...result });
});

module.exports = router;
