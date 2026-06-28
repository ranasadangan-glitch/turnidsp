// GET /api/kpi?date=YYYY-MM-DD&branch=CODE
// ─────────────────────────────────────────────────────────────────────────────
// THE ROOT CAUSE OF dashboard ↔ scheduler disconnect:
//
//   Scheduler stores data in:  scheduler_drivers + schedule_entries + schedule_forecasts
//   Dashboard (old) read from: employees         + schedules        + forecasts
//
// These are two completely separate systems.  The scheduler's DAS never
// appeared on the dashboard because the dashboard queries had no knowledge
// of scheduler_drivers / schedule_entries.
//
// FIX: every KPI query now uses a UNIFIED VIEW that merges both systems:
//
//   unified_drivers  =  employees  UNION  scheduler_drivers (not yet in employees)
//   unified_entries  =  schedules  UNION  schedule_entries  (with a resolved shift_code)
//   unified_forecast =  forecasts  UNION  schedule_forecasts (by date)
//
// This way the dashboard always reflects exactly what the scheduler shows.
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope } = require('../middleware/auth');

router.use(auth, loadScope);

async function safe(fn) {
  try { return await fn(); }
  catch (e) { console.error('[KPI]', e.message); return null; }
}

// ── Shared CTE fragments ──────────────────────────────────────────────────────
//
// unified_drivers — all active DAS from both systems
//   • employees rows (standard HR system)
//   • scheduler_drivers rows whose employee_id is NULL (scheduler-only, not yet promoted)
//
// unified_entries — all shift assignments from both systems for a given date
//   • schedules rows (HR system)
//   • schedule_entries rows (scheduler system), resolved by month+day
//
// unified_forecast — all forecast data from both tables for a given date
//   • forecasts rows joined through branch+service
//   • schedule_forecasts rows

function buildUnifiedCTEs(date, branch, scope) {
  // Branch filter: admins see everything; scoped users see their branches
  // For employees table: branch_id FK
  // For scheduler_drivers: filiale TEXT (branch code)
  const branchCode = branch || null;

  return `
-- ── UNIFIED DRIVERS ────────────────────────────────────────────────────────
-- All active DAS: from employees table + scheduler_drivers not yet linked
unified_drivers AS (
  SELECT
    e.id::text                          AS driver_key,
    e.first_name                        AS nome,
    e.last_name                         AS cognome,
    b.code                              AS branch_code,
    e.branch_id                         AS branch_id,
    COALESCE(st.code, e.default_shift_code) AS default_code,
    e.status,
    e.contract_end_date,
    e.contract_type_id,
    ct.label                            AS contract_label,
    'employee'                          AS source
  FROM employees e
  LEFT JOIN branches b  ON b.id  = e.branch_id
  LEFT JOIN service_types st ON st.id = e.service_type_id
  LEFT JOIN contract_types ct ON ct.id = e.contract_type_id
  WHERE e.status = 'active'
    ${branchCode ? `AND b.code = '${branchCode.replace(/'/g, "''")}'` : ''}

  UNION ALL

  SELECT
    'sd_' || sd.id::text                AS driver_key,
    sd.nome,
    sd.cognome,
    sd.filiale                          AS branch_code,
    NULL::int                           AS branch_id,
    sd.default_code,
    sd.status,
    sd.expiry_date                      AS contract_end_date,
    NULL::int                           AS contract_type_id,
    sd.contratto                        AS contract_label,
    'scheduler'                         AS source
  FROM scheduler_drivers sd
  WHERE sd.status = 'active'
    AND sd.employee_id IS NULL          -- only those NOT yet linked to employees
    ${branchCode ? `AND sd.filiale = '${branchCode.replace(/'/g, "''")}'` : ''}
),

-- ── UNIFIED ENTRIES ─────────────────────────────────────────────────────────
-- All shift assignments for the target date, from both tables
unified_entries AS (
  -- From standard schedules table (HR system)
  SELECT
    e.id::text          AS driver_key,
    s.shift_code,
    b.code              AS branch_code,
    sc.is_work,
    sc.is_absence,
    sc.is_off,
    sc.category
  FROM schedules s
  JOIN employees e    ON e.id = s.employee_id
  LEFT JOIN branches b ON b.id = e.branch_id
  LEFT JOIN shift_codes sc ON sc.code = s.shift_code
  WHERE s.work_date = $1::date
    ${branchCode ? `AND b.code = '${branchCode.replace(/'/g, "''")}'` : ''}

  UNION ALL

  -- From scheduler's schedule_entries table (by month + day)
  SELECT
    COALESCE('sd_' || se.local_driver_id::text,
             se.employee_id::text)      AS driver_key,
    se.shift_code,
    se.branch_code,
    sc.is_work,
    sc.is_absence,
    sc.is_off,
    sc.category
  FROM schedule_entries se
  LEFT JOIN shift_codes sc ON sc.code = se.shift_code
  WHERE se.schedule_month = date_trunc('month', $1::date)
    AND se.day_of_month   = EXTRACT(DAY FROM $1::date)::int
    AND se.employee_id IS NULL          -- only scheduler-only entries (not already in HR schedules)
    ${branchCode ? `AND se.branch_code = '${branchCode.replace(/'/g, "''")}'` : ''}
),

-- ── UNIFIED FORECAST ────────────────────────────────────────────────────────
-- All forecast quantities for the target date
unified_forecast AS (
  -- From standard forecasts table (HR system)
  SELECT COALESCE(sum(f.qty), 0)::int AS total_fc
  FROM forecasts f
  JOIN branches b ON b.id = f.branch_id
  WHERE f.forecast_date = $1::date
    ${branchCode ? `AND b.code = '${branchCode.replace(/'/g, "''")}'` : ''}

  UNION ALL

  -- From scheduler's schedule_forecasts table
  SELECT COALESCE(sum(sf.qty), 0)::int AS total_fc
  FROM schedule_forecasts sf
  WHERE sf.schedule_month = date_trunc('month', $1::date)
    AND sf.day_of_month   = EXTRACT(DAY FROM $1::date)::int
    ${branchCode ? `AND sf.branch_code = '${branchCode.replace(/'/g, "''")}'` : ''}
)
`;
}

// ── DSP Operations table (for dashboard "per service" breakdown) ──────────────
function buildUnifiedForecastTrend(date, branch) {
  const branchCode = branch || null;
  return `
WITH
fc_hr AS (
  SELECT f.forecast_date::date AS d, COALESCE(sum(f.qty),0)::int AS qty
  FROM forecasts f JOIN branches b ON b.id = f.branch_id
  WHERE f.forecast_date BETWEEN ($1::date - 29) AND $1::date
    ${branchCode ? `AND b.code = '${branchCode.replace(/'/g,"''")}'` : ''}
  GROUP BY 1
),
fc_sc AS (
  SELECT (sf.schedule_month + (sf.day_of_month - 1) * INTERVAL '1 day')::date AS d,
         COALESCE(sum(sf.qty),0)::int AS qty
  FROM schedule_forecasts sf
  WHERE (sf.schedule_month + (sf.day_of_month - 1) * INTERVAL '1 day')::date
         BETWEEN ($1::date - 29) AND $1::date
    ${branchCode ? `AND sf.branch_code = '${branchCode.replace(/'/g,"''")}'` : ''}
  GROUP BY 1
),
pl_hr AS (
  SELECT s.work_date::date AS d, count(*)::int AS cnt
  FROM schedules s JOIN employees e ON e.id = s.employee_id
  LEFT JOIN branches b ON b.id = e.branch_id
  JOIN shift_codes sc ON sc.code = s.shift_code
  WHERE sc.is_work AND s.work_date BETWEEN ($1::date - 29) AND $1::date
    ${branchCode ? `AND b.code = '${branchCode.replace(/'/g,"''")}'` : ''}
  GROUP BY 1
),
pl_sc AS (
  SELECT (se.schedule_month + (se.day_of_month - 1) * INTERVAL '1 day')::date AS d,
         count(*)::int AS cnt
  FROM schedule_entries se JOIN shift_codes sc ON sc.code = se.shift_code
  WHERE sc.is_work
    AND (se.schedule_month + (se.day_of_month - 1) * INTERVAL '1 day')::date
         BETWEEN ($1::date - 29) AND $1::date
    AND se.employee_id IS NULL
    ${branchCode ? `AND se.branch_code = '${branchCode.replace(/'/g,"''")}'` : ''}
  GROUP BY 1
),
all_days AS (
  SELECT generate_series($1::date - 29, $1::date, '1 day'::interval)::date AS d
),
fc_all AS (SELECT d, COALESCE(fc_hr.qty,0)+COALESCE(fc_sc.qty,0) AS qty FROM all_days LEFT JOIN fc_hr USING(d) LEFT JOIN fc_sc USING(d)),
pl_all AS (SELECT d, COALESCE(pl_hr.cnt,0)+COALESCE(pl_sc.cnt,0) AS cnt FROM all_days LEFT JOIN pl_hr USING(d) LEFT JOIN pl_sc USING(d))
SELECT fa.d::text AS d, fa.qty::int AS forecast, pa.cnt::int AS planned
FROM fc_all fa JOIN pl_all pa USING(d) ORDER BY d
`;
}

// ── Main KPI endpoint ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const date   = req.query.date   || new Date().toISOString().slice(0, 10);
  const branch = req.query.branch || null;
  const result = {};

  const cte = buildUnifiedCTEs(date, branch, req.scope);

  // ── 1. Drivers / DAS count ────────────────────────────────────────────────
  result.drivers = await safe(async () => {
    const r = await pool.query(`
      WITH ${cte},
      entries AS (SELECT driver_key, shift_code, is_work, is_absence, is_off FROM unified_entries)
      SELECT
        count(DISTINCT ud.driver_key)::int                                   AS total,
        count(DISTINCT e.driver_key) FILTER (WHERE e.is_work)::int           AS present,
        count(DISTINCT e.driver_key) FILTER (WHERE e.is_absence)::int        AS absent,
        count(DISTINCT e.driver_key) FILTER (WHERE e.is_off)::int            AS on_leave
      FROM unified_drivers ud
      LEFT JOIN entries e ON e.driver_key = ud.driver_key
    `, [date]);
    const row = r.rows[0] || {};
    return {
      total:    row.total    || 0,
      present:  row.present  || 0,
      absent:   row.absent   || 0,
      on_leave: row.on_leave || 0,
      late: 0,
    };
  });

  // ── 2. Forecast vs Planned ────────────────────────────────────────────────
  result.forecast = await safe(async () => {
    const r = await pool.query(`
      WITH ${cte}
      SELECT
        (SELECT COALESCE(sum(total_fc),0)::int FROM unified_forecast) AS fc,
        (SELECT count(DISTINCT driver_key)::int FROM unified_entries WHERE is_work) AS planned
    `, [date]);
    const row = r.rows[0] || {};
    const f = row.fc || 0;
    const p = row.planned || 0;
    const delta = p - f;
    return { forecast: f, planned: p, delta, delta_pct: f ? Math.round(delta / f * 100) : 0 };
  });

  // ── 3. Attendance breakdown ───────────────────────────────────────────────
  result.attendance = await safe(async () => {
    const r = await pool.query(`
      WITH ${cte}
      SELECT
        count(DISTINCT driver_key) FILTER (WHERE is_work)::int      AS present,
        count(DISTINCT driver_key) FILTER (WHERE is_absence)::int   AS absent,
        count(DISTINCT driver_key) FILTER (WHERE is_off)::int       AS vacation,
        count(DISTINCT driver_key) FILTER (WHERE category ILIKE '%mal%')::int AS medical,
        count(DISTINCT driver_key) FILTER (WHERE category ILIKE '%form%' OR category ILIKE '%train%')::int AS training
      FROM unified_entries
    `, [date]);
    const row = r.rows[0] || {};
    return {
      present:  row.present  || 0,
      absent:   row.absent   || 0,
      medical:  row.medical  || 0,
      vacation: row.vacation || 0,
      training: row.training || 0,
      half_day: 0,
      other: 0,
    };
  });

  // ── 4. Contracts expiring ─────────────────────────────────────────────────
  // Uses unified_drivers which has contract_end_date from both sources
  result.contracts = await safe(async () => {
    const r = await pool.query(`
      WITH ${cte}
      SELECT
        count(*) FILTER (WHERE contract_end_date < $1::date)::int                                AS expired,
        count(*) FILTER (WHERE contract_end_date BETWEEN $1::date AND $1::date + 7)::int         AS in_7,
        count(*) FILTER (WHERE contract_end_date BETWEEN $1::date AND $1::date + 15)::int        AS in_15,
        count(*) FILTER (WHERE contract_end_date BETWEEN $1::date AND $1::date + 30)::int        AS in_30
      FROM unified_drivers
      WHERE contract_end_date IS NOT NULL
    `, [date]);
    return r.rows[0] || { expired: 0, in_7: 0, in_15: 0, in_30: 0 };
  });

  // ── 5. Attendance trend (last 30 days) ────────────────────────────────────
  // Merges HR schedules + scheduler schedule_entries
  result.attendance_trend = await safe(async () => {
    const brC = branch ? `'${branch.replace(/'/g,"''")}'` : null;
    const r = await pool.query(`
      WITH
      hr AS (
        SELECT s.work_date::date AS d,
               count(*) FILTER (WHERE sc.is_work)::int    AS present,
               count(*) FILTER (WHERE sc.is_absence)::int AS absent
          FROM schedules s
          JOIN employees e ON e.id = s.employee_id
          LEFT JOIN branches b ON b.id = e.branch_id
          JOIN shift_codes sc ON sc.code = s.shift_code
         WHERE s.work_date BETWEEN ($1::date - 29) AND $1::date
           ${brC ? `AND b.code = ${brC}` : ''}
         GROUP BY 1
      ),
      sc AS (
        SELECT (se.schedule_month + (se.day_of_month - 1) * INTERVAL '1 day')::date AS d,
               count(*) FILTER (WHERE sk.is_work)::int    AS present,
               count(*) FILTER (WHERE sk.is_absence)::int AS absent
          FROM schedule_entries se
          LEFT JOIN shift_codes sk ON sk.code = se.shift_code
         WHERE (se.schedule_month + (se.day_of_month - 1) * INTERVAL '1 day')::date
               BETWEEN ($1::date - 29) AND $1::date
           AND se.employee_id IS NULL
           ${brC ? `AND se.branch_code = ${brC}` : ''}
         GROUP BY 1
      ),
      days AS (SELECT generate_series($1::date - 29, $1::date, '1 day'::interval)::date AS d)
      SELECT
        days.d::text AS d,
        (COALESCE(hr.present,0) + COALESCE(sc.present,0))::int AS present,
        (COALESCE(hr.absent,0)  + COALESCE(sc.absent,0))::int  AS absent
      FROM days
      LEFT JOIN hr ON hr.d = days.d
      LEFT JOIN sc ON sc.d = days.d
      ORDER BY days.d
    `, [date]);
    return r.rows;
  });

  // ── 6. Forecast accuracy trend (last 30 days) ─────────────────────────────
  result.forecast_trend = await safe(async () => {
    const r = await pool.query(buildUnifiedForecastTrend(date, branch), [date]);
    return r.rows;
  });

  // ── 7. Recent activity ────────────────────────────────────────────────────
  result.activity = await safe(async () => {
    // Merge platform audit_log + scheduler schedule_audit_log
    const r = await pool.query(`
      SELECT username, role, entity, action, detail, ts FROM audit_log
      UNION ALL
      SELECT actor AS username, 'scheduler' AS role, 'schedule' AS entity,
             action, action AS detail, logged_at AS ts
        FROM schedule_audit_log
      ORDER BY ts DESC LIMIT 25
    `);
    return r.rows;
  });

  // ── 8. Employee / driver growth (monthly) ──────────────────────────────────
  // Counts new records from both tables
  result.employee_growth = await safe(async () => {
    const brC = branch ? `'${branch.replace(/'/g,"''")}'` : null;
    const r = await pool.query(`
      WITH hr AS (
        SELECT date_trunc('month', created_at)::date AS month, count(*)::int AS added
          FROM employees e
          LEFT JOIN branches b ON b.id = e.branch_id
         WHERE created_at >= now() - interval '12 months'
           ${brC ? `AND b.code = ${brC}` : ''}
         GROUP BY 1
      ),
      sc AS (
        SELECT date_trunc('month', created_at)::date AS month, count(*)::int AS added
          FROM scheduler_drivers sd
         WHERE created_at >= now() - interval '12 months'
           AND sd.employee_id IS NULL
           ${brC ? `AND sd.filiale = ${brC}` : ''}
         GROUP BY 1
      ),
      months AS (
        SELECT generate_series(date_trunc('month', now() - interval '11 months'),
                               date_trunc('month', now()), '1 month')::date AS month
      )
      SELECT to_char(months.month, 'YYYY-MM') AS month,
             (COALESCE(hr.added,0) + COALESCE(sc.added,0))::int AS added
        FROM months
        LEFT JOIN hr ON hr.month = months.month
        LEFT JOIN sc ON sc.month = months.month
       ORDER BY months.month
    `, []);
    return r.rows;
  });

  // ── 9. Absence type distribution ──────────────────────────────────────────
  result.absence_types = await safe(async () => {
    const r = await pool.query(`
      SELECT absence_type, count(*)::int AS cnt
        FROM absences a
        JOIN employees e ON e.id = a.employee_id
       WHERE a.start_date >= now() - interval '90 days'
       GROUP BY 1 ORDER BY cnt DESC LIMIT 8
    `);
    return r.rows;
  });

  // ── 10. DSP Operations breakdown (per branch for main table) ──────────────
  result.dsp = await safe(async () => {
    const brC = branch ? `'${branch.replace(/'/g,"''")}'` : null;
    // Get all distinct branches with data
    const r = await pool.query(`
      WITH
      drivers_by_branch AS (
        SELECT branch_code, count(DISTINCT driver_key)::int AS drivers
        FROM (
          SELECT COALESCE(b.code, '') AS branch_code, e.id::text AS driver_key
            FROM employees e LEFT JOIN branches b ON b.id = e.branch_id
           WHERE e.status = 'active' ${brC ? `AND b.code = ${brC}` : ''}
          UNION ALL
          SELECT sd.filiale AS branch_code, 'sd_' || sd.id::text AS driver_key
            FROM scheduler_drivers sd WHERE sd.status = 'active' AND sd.employee_id IS NULL
            ${brC ? `AND sd.filiale = ${brC}` : ''}
        ) x
        GROUP BY branch_code
      ),
      entries_by_branch AS (
        SELECT branch_code,
               count(*) FILTER (WHERE is_work)::int    AS present,
               count(*) FILTER (WHERE is_absence)::int AS absent,
               count(*) FILTER (WHERE is_off)::int     AS off
        FROM (
          SELECT b.code AS branch_code, sc.is_work, sc.is_absence, sc.is_off
            FROM schedules s JOIN employees e ON e.id = s.employee_id
            LEFT JOIN branches b ON b.id = e.branch_id
            JOIN shift_codes sc ON sc.code = s.shift_code
           WHERE s.work_date = $1::date ${brC ? `AND b.code = ${brC}` : ''}
          UNION ALL
          SELECT se.branch_code, sk.is_work, sk.is_absence, sk.is_off
            FROM schedule_entries se LEFT JOIN shift_codes sk ON sk.code = se.shift_code
           WHERE se.schedule_month = date_trunc('month', $1::date)
             AND se.day_of_month = EXTRACT(DAY FROM $1::date)::int
             AND se.employee_id IS NULL ${brC ? `AND se.branch_code = ${brC}` : ''}
        ) x
        GROUP BY branch_code
      )
      SELECT d.branch_code,
             d.drivers,
             COALESCE(e.present, 0) AS present,
             COALESCE(e.absent,  0) AS absent,
             COALESCE(e.off,     0) AS off
        FROM drivers_by_branch d
        LEFT JOIN entries_by_branch e USING(branch_code)
       WHERE d.branch_code != ''
       ORDER BY d.branch_code
    `, [date]);
    return r.rows;
  });

  res.json({ date, ...result });
});

module.exports = router;
