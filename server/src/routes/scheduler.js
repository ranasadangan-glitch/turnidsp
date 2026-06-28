// Scheduler API — replaces localStorage with PostgreSQL.
// All state that was previously in:
//   localStorage["turniDSP_YYYY-MM"]  → schedule_entries + scheduler_drivers + schedule_forecasts
//   localStorage["turniDSP_config"]   → scheduler_config
// is now read from and written to the database.
const router = require('express').Router();
const { pool, withTx } = require('../db/pool');
const { auth, loadScope, audit } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(auth, loadScope);

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function monthStart(ym) {
  // Accept "YYYY-MM" or a full date; always return "YYYY-MM-01"
  if (!ym) throw new Error('month required (YYYY-MM)');
  const m = String(ym).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('invalid month format');
  return m + '-01';
}

function scopeFilter(scope, params, col = 'branch_code') {
  if (scope.admin || !scope.branches) return '';
  if (!scope.branches.length) return ' AND 1=0';
  // branches is array of IDs; for scheduler we use branch_code text col
  // so we join to branches table only when needed; simpler: no restriction
  // if the user has branches assigned — we trust loadScope for employees,
  // but scheduler_drivers use text branch_code directly.
  // For now: no row-level restriction by branch_id array (scheduler uses codes).
  // Admin sees all; team_leaders see their branch via UI filter, not SQL here.
  return '';
}

async function logSchedulerAction(actor, month, branchCode, action, opts = {}) {
  try {
    await pool.query(
      `INSERT INTO schedule_audit_log
         (schedule_month, branch_code, actor, action, driver_id, employee_id, day_of_month, old_code, new_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [month, branchCode || null, actor, action,
       opts.driver_id || null, opts.employee_id || null,
       opts.day || null, opts.old_code || null, opts.new_code || null]
    );
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────
// SCHEDULE ENTRIES (the grid cells)
// ─────────────────────────────────────────────────────────

// GET /api/scheduler/entries?month=YYYY-MM&branch=DLO1
// Returns the full grid for a month. Used by loadMonth().
router.get('/entries', async (req, res) => {
  try {
    const month = monthStart(req.query.month);
    const params = [month];
    let sql = `
      SELECT se.id, se.employee_id, se.local_driver_id, se.day_of_month,
             se.shift_code, se.branch_code, se.updated_by, se.updated_at
        FROM schedule_entries se
       WHERE se.schedule_month = $1`;
    if (req.query.branch) { params.push(req.query.branch); sql += ` AND se.branch_code = $${params.length}`; }
    sql += ' ORDER BY se.employee_id NULLS LAST, se.local_driver_id, se.day_of_month';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/scheduler/weekly?from=YYYY-MM-DD&branch=DLO1
// Returns entries for a 7-day window. Used by the weekly view.
router.get('/weekly', async (req, res) => {
  try {
    const { from, branch } = req.query;
    if (!from) return res.status(400).json({ error: 'from richiesto (YYYY-MM-DD)' });
    const params = [from];
    let sql = `
      SELECT se.employee_id, se.local_driver_id, se.day_of_month,
             se.shift_code, se.branch_code, se.schedule_month,
             sd.cognome, sd.nome, sd.filiale, sd.service,
             e.first_name, e.last_name
        FROM schedule_entries se
        LEFT JOIN scheduler_drivers sd ON sd.id = se.local_driver_id
        LEFT JOIN employees e ON e.id = se.employee_id
       WHERE se.schedule_month = date_trunc('month', $1::date)
         AND se.day_of_month BETWEEN EXTRACT(DAY FROM $1::date)
             AND EXTRACT(DAY FROM ($1::date + INTERVAL '6 days'))`;
    if (branch) { params.push(branch); sql += ` AND se.branch_code = $${params.length}`; }
    sql += ' ORDER BY COALESCE(sd.cognome, e.last_name), se.day_of_month';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/scheduler/monthly?month=YYYY-MM&branch=DLO1
// Returns all entries for a full month, grouped by driver. Used by the monthly view.
router.get('/monthly', async (req, res) => {
  try {
    const month = monthStart(req.query.month);
    const params = [month];
    let sql = `
      SELECT se.employee_id, se.local_driver_id, se.day_of_month,
             se.shift_code, se.branch_code,
             sd.cognome, sd.nome, sd.filiale, sd.service, sd.contratto,
             e.first_name, e.last_name,
             b.code AS emp_branch_code
        FROM schedule_entries se
        LEFT JOIN scheduler_drivers sd ON sd.id = se.local_driver_id
        LEFT JOIN employees e ON e.id = se.employee_id
        LEFT JOIN branches b ON b.id = e.branch_id
       WHERE se.schedule_month = $1`;
    if (req.query.branch) { params.push(req.query.branch); sql += ` AND se.branch_code = $${params.length}`; }
    sql += ' ORDER BY COALESCE(sd.cognome, e.last_name), COALESCE(sd.nome, e.first_name), se.day_of_month';
    const { rows } = await pool.query(sql, params);

    // Group into { driver_key: { info, days: {1: code, 2: code, ...} } }
    const grouped = {};
    for (const r of rows) {
      const key = r.employee_id ? `e_${r.employee_id}` : `l_${r.local_driver_id}`;
      if (!grouped[key]) {
        grouped[key] = {
          employee_id: r.employee_id,
          local_driver_id: r.local_driver_id,
          cognome: r.cognome || r.last_name,
          nome: r.nome || r.first_name,
          filiale: r.filiale || r.emp_branch_code,
          service: r.service,
          contratto: r.contratto,
          days: {},
        };
      }
      grouped[key].days[r.day_of_month] = r.shift_code;
    }
    res.json(Object.values(grouped));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PUT /api/scheduler/entries  — upsert a single cell
// Body: { month, employee_id?, local_driver_id?, day, shift_code, branch_code }
// Empty shift_code → delete the cell.
router.put('/entries', requirePermission('schedule.manage'), async (req, res) => {
  try {
    const { month, employee_id, local_driver_id, day, shift_code, branch_code } = req.body || {};
    if (!month || !day) return res.status(400).json({ error: 'month e day richiesti' });
    if (!employee_id && !local_driver_id) return res.status(400).json({ error: 'employee_id o local_driver_id richiesto' });
    const m = monthStart(month);
    const empId = employee_id || null;
    const locId = local_driver_id || null;

    // Fetch old code for audit
    const old = await pool.query(
      `SELECT shift_code FROM schedule_entries
        WHERE schedule_month=$1 AND (employee_id=$2 OR (employee_id IS NULL AND local_driver_id=$3))
          AND day_of_month=$4`,
      [m, empId, locId, day]
    );
    const oldCode = old.rows[0]?.shift_code || null;

    if (!shift_code) {
      await pool.query(
        `DELETE FROM schedule_entries
          WHERE schedule_month=$1 AND day_of_month=$4
            AND (employee_id=$2 OR (employee_id IS NULL AND local_driver_id=$3))`,
        [m, empId, locId, day]
      );
    } else {
      await pool.query(
        `INSERT INTO schedule_entries
           (schedule_month, employee_id, local_driver_id, day_of_month, shift_code, branch_code, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (employee_id, schedule_month, day_of_month)
           WHERE employee_id IS NOT NULL
         DO UPDATE SET shift_code=EXCLUDED.shift_code, updated_by=EXCLUDED.updated_by, updated_at=now()
        `,
        [m, empId, locId, day, shift_code, branch_code || null, req.user.username]
      );
      // Handle local_driver_id conflict separately (PG doesn't support two partial ON CONFLICT)
      if (!empId && locId) {
        await pool.query(
          `INSERT INTO schedule_entries
             (schedule_month, employee_id, local_driver_id, day_of_month, shift_code, branch_code, updated_by)
           VALUES ($1,NULL,$2,$3,$4,$5,$6)
           ON CONFLICT (local_driver_id, schedule_month, day_of_month)
             WHERE local_driver_id IS NOT NULL
           DO UPDATE SET shift_code=EXCLUDED.shift_code, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [m, locId, day, shift_code, branch_code || null, req.user.username]
        );
      }
    }

    await logSchedulerAction(req.user.username, m, branch_code, `Turno g${day}: ${oldCode || 'vuoto'} → ${shift_code || 'vuoto'}`,
      { employee_id: empId, driver_id: locId, day, old_code: oldCode, new_code: shift_code || null });
    await audit(req, 'schedule', empId || locId, 'update', `${m} g${day}: ${shift_code || 'vuoto'}`);
    res.json({ ok: true });
  } catch (e) { console.error('entries PUT:', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/scheduler/entries/bulk  — upsert many cells in a transaction
// Body: { month, branch_code, items: [{employee_id?, local_driver_id?, day, shift_code}] }
router.post('/entries/bulk', requirePermission('schedule.manage'), async (req, res) => {
  try {
    const { month, branch_code, items = [] } = req.body || {};
    if (!month) return res.status(400).json({ error: 'month richiesto' });
    const m = monthStart(month);
    let saved = 0;
    await withTx(async (c) => {
      for (const it of items) {
        const empId = it.employee_id || null;
        const locId = it.local_driver_id || null;
        if (!it.day || (!empId && !locId)) continue;
        if (!it.shift_code) {
          await c.query(
            `DELETE FROM schedule_entries WHERE schedule_month=$1 AND day_of_month=$4
               AND (employee_id=$2 OR (employee_id IS NULL AND local_driver_id=$3))`,
            [m, empId, locId, it.day]
          );
        } else if (empId) {
          await c.query(
            `INSERT INTO schedule_entries (schedule_month, employee_id, day_of_month, shift_code, branch_code, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (employee_id, schedule_month, day_of_month) WHERE employee_id IS NOT NULL
             DO UPDATE SET shift_code=EXCLUDED.shift_code, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [m, empId, it.day, it.shift_code, branch_code || null, req.user.username]
          );
        } else {
          await c.query(
            `INSERT INTO schedule_entries (schedule_month, local_driver_id, day_of_month, shift_code, branch_code, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (local_driver_id, schedule_month, day_of_month) WHERE local_driver_id IS NOT NULL
             DO UPDATE SET shift_code=EXCLUDED.shift_code, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [m, locId, it.day, it.shift_code, branch_code || null, req.user.username]
          );
        }
        saved++;
      }
    });
    await logSchedulerAction(req.user.username, m, branch_code, `Bulk save: ${saved} celle`);
    await audit(req, 'schedule', null, 'update', `Bulk ${saved} celle ${m} ${branch_code || ''}`);
    res.json({ ok: true, saved });
  } catch (e) { console.error('entries bulk:', e.message); res.status(500).json({ error: e.message }); }
});

// DELETE /api/scheduler/entries?month=YYYY-MM&branch=DLO1  — reset a month
router.delete('/entries', requirePermission('schedule.manage'), async (req, res) => {
  try {
    const month = monthStart(req.query.month);
    const params = [month];
    let sql = 'DELETE FROM schedule_entries WHERE schedule_month=$1';
    if (req.query.branch) { params.push(req.query.branch); sql += ` AND branch_code=$${params.length}`; }
    const r = await pool.query(sql, params);
    await logSchedulerAction(req.user.username, month, req.query.branch, `Turni del mese azzerati (${r.rowCount} righe)`);
    await audit(req, 'schedule', null, 'delete', `Reset mese ${month} ${req.query.branch || ''}`);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// SCHEDULER DRIVERS (local roster)
// ─────────────────────────────────────────────────────────

// GET /api/scheduler/drivers?branch=&status=
router.get('/drivers', async (req, res) => {
  try {
    const params = [];
    let sql = 'SELECT * FROM scheduler_drivers WHERE 1=1';
    if (req.query.branch) { params.push(req.query.branch); sql += ` AND filiale=$${params.length}`; }
    if (req.query.status) { params.push(req.query.status); sql += ` AND status=$${params.length}`; }
    else sql += " AND status != 'pending'";
    sql += ' ORDER BY cognome, nome';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scheduler/drivers  — add a driver to the scheduler roster
router.post('/drivers', requirePermission('employee.manage'), async (req, res) => {
  try {
    const { cognome, nome, filiale, service, contratto, ctr_type, expiry_date,
            work_days, default_code, status, transporter_id, device, hire_date } = req.body || {};
    if (!cognome || !nome) return res.status(400).json({ error: 'cognome e nome richiesti' });
    const { rows } = await pool.query(
      `INSERT INTO scheduler_drivers
         (cognome, nome, filiale, service, contratto, ctr_type, expiry_date,
          work_days, default_code, status, transporter_id, device, hire_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [cognome, nome, filiale || 'DLO1', service || null, contratto || null,
       ctr_type || 'indeterminato', expiry_date || null,
       work_days || [1,2,3,4,5], default_code || null,
       status || 'active', transporter_id || null, device || null, hire_date || null,
       req.user.username]
    );
    await audit(req, 'employee', rows[0].id, 'create', `Scheduler driver: ${cognome} ${nome}`);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/scheduler/drivers/:id
router.put('/drivers/:id', requirePermission('employee.manage'), async (req, res) => {
  try {
    const fields = ['cognome','nome','filiale','service','contratto','ctr_type','expiry_date',
                    'work_days','default_code','status','transporter_id','device','hire_date','employee_id'];
    const b = req.body || {};
    const cols = fields.filter(f => b[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'Nessun campo' });
    const sets = cols.map((f, i) => `${f}=$${i+1}`);
    const vals = cols.map(f => b[f]);
    const { rows } = await pool.query(
      `UPDATE scheduler_drivers SET ${sets.join(',')} WHERE id=$${cols.length+1} RETURNING *`,
      [...vals, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Non trovato' });
    await audit(req, 'employee', req.params.id, 'update', `Scheduler driver aggiornato: ${rows[0].cognome} ${rows[0].nome}`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scheduler/drivers/:id/approve  — promote pending driver to active + link/create employee
router.post('/drivers/:id/approve', requirePermission('employee.manage'), async (req, res) => {
  try {
    const { rows: dr } = await pool.query('SELECT * FROM scheduler_drivers WHERE id=$1', [req.params.id]);
    if (!dr[0]) return res.status(404).json({ error: 'Non trovato' });
    const d = dr[0];

    // Create or link to employees
    let empId = d.employee_id;
    if (!empId) {
      const { rows: emp } = await pool.query(
        `INSERT INTO employees (first_name, last_name, status, hire_date, default_shift_code, added_by)
         VALUES ($1,$2,'active',$3,$4,$5) RETURNING id`,
        [d.nome, d.cognome, d.hire_date || null, d.default_code || null, req.user.username]
      );
      empId = emp[0].id;
    }
    await pool.query(
      'UPDATE scheduler_drivers SET status=$1, employee_id=$2 WHERE id=$3',
      ['active', empId, req.params.id]
    );
    // Backfill branch_code on any pending entries
    await pool.query(
      'UPDATE schedule_entries SET employee_id=$1 WHERE local_driver_id=$2',
      [empId, +req.params.id]
    );
    await audit(req, 'employee', empId, 'create', `Driver approvato: ${d.cognome} ${d.nome}`);
    res.json({ ok: true, employee_id: empId });
  } catch (e) { console.error('approve:', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/scheduler/drivers/import  — bulk import from the scheduler's JSON export
router.post('/drivers/import', requirePermission('employee.manage'), async (req, res) => {
  try {
    const drivers = (req.body && req.body.drivers) || [];
    let added = 0;
    await withTx(async (c) => {
      for (const d of drivers) {
        if (!d.cognome && !d.nome) continue;
        await c.query(
          `INSERT INTO scheduler_drivers
             (cognome, nome, filiale, service, contratto, ctr_type, expiry_date,
              work_days, default_code, status, transporter_id, device, hire_date, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT DO NOTHING`,
          [d.cognome || '', d.nome || '', d.filiale || 'DLO1', d.service || null,
           d.contratto || null, d.ctrType || 'indeterminato', d.expiry || null,
           d.workDays || [1,2,3,4,5], d.defaultCode || null, d.status || 'active',
           d.transporterId || null, d.device || null, d.hireDate || null, req.user.username]
        );
        added++;
      }
    });
    await audit(req, 'employee', null, 'create', `Import scheduler drivers: ${added}`);
    res.json({ ok: true, added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// FORECASTS
// ─────────────────────────────────────────────────────────

// GET /api/scheduler/forecasts?month=YYYY-MM&branch=DLO1
router.get('/forecasts', async (req, res) => {
  try {
    const month = monthStart(req.query.month);
    const params = [month];
    let sql = 'SELECT * FROM schedule_forecasts WHERE schedule_month=$1';
    if (req.query.branch) { params.push(req.query.branch); sql += ` AND branch_code=$${params.length}`; }
    sql += ' ORDER BY service_key, day_of_month';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PUT /api/scheduler/forecasts  { month, branch_code, service_key, day, qty }
router.put('/forecasts', requirePermission('forecast.manage'), async (req, res) => {
  try {
    const { month, branch_code, service_key, day, qty } = req.body || {};
    if (!month || !service_key || !day) return res.status(400).json({ error: 'month/service_key/day richiesti' });
    const m = monthStart(month);
    await pool.query(
      `INSERT INTO schedule_forecasts (schedule_month, branch_code, service_key, day_of_month, qty, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (schedule_month, branch_code, service_key, day_of_month)
       DO UPDATE SET qty=EXCLUDED.qty, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [m, branch_code || 'DLO1', service_key, day, +qty || 0, req.user.username]
    );
    await logSchedulerAction(req.user.username, m, branch_code, `Forecast ${service_key} g${day}=${qty}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/scheduler/forecasts/bulk  { month, branch_code, items: [{service_key,day,qty}] }
router.post('/forecasts/bulk', requirePermission('forecast.manage'), async (req, res) => {
  try {
    const { month, branch_code = 'DLO1', items = [] } = req.body || {};
    if (!month) return res.status(400).json({ error: 'month richiesto' });
    const m = monthStart(month);
    let saved = 0;
    await withTx(async (c) => {
      for (const it of items) {
        if (!it.service_key || !it.day) continue;
        await c.query(
          `INSERT INTO schedule_forecasts (schedule_month, branch_code, service_key, day_of_month, qty, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (schedule_month, branch_code, service_key, day_of_month)
           DO UPDATE SET qty=EXCLUDED.qty, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [m, branch_code, it.service_key, it.day, +it.qty || 0, req.user.username]
        );
        saved++;
      }
    });
    await audit(req, 'config', null, 'update', `Bulk forecast ${m} ${branch_code}: ${saved} righe`);
    res.json({ ok: true, saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// CONFIG  (shift codes, services, contracts, etc.)
// ─────────────────────────────────────────────────────────

// GET /api/scheduler/config?branch=DLO1&key=codes
router.get('/config', async (req, res) => {
  try {
    const params = [req.query.branch || 'DLO1'];
    let sql = 'SELECT config_key, config_value, updated_at FROM scheduler_config WHERE branch_code=$1';
    if (req.query.key) { params.push(req.query.key); sql += ` AND config_key=$${params.length}`; }
    sql += ' ORDER BY config_key';
    const { rows } = await pool.query(sql, params);
    // Return as { key: value } map for easy frontend consumption
    const out = {};
    for (const r of rows) out[r.config_key] = r.config_value;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/scheduler/config  { branch_code, key, value }
router.put('/config', requirePermission('config.manage'), async (req, res) => {
  try {
    const { branch_code = 'DLO1', key, value } = req.body || {};
    if (!key || value === undefined) return res.status(400).json({ error: 'key e value richiesti' });
    await pool.query(
      `INSERT INTO scheduler_config (branch_code, config_key, config_value, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (branch_code, config_key)
       DO UPDATE SET config_value=EXCLUDED.config_value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [branch_code, key, JSON.stringify(value), req.user.username]
    );
    await audit(req, 'config', null, 'update', `Scheduler config ${branch_code}.${key} aggiornato`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scheduler/config/import  — import a full state.config object
// { branch_code, config: { codes:[…], services:[…], contracts:[…], … } }
router.post('/config/import', requirePermission('config.manage'), async (req, res) => {
  try {
    const { branch_code = 'DLO1', config } = req.body || {};
    if (!config) return res.status(400).json({ error: 'config richiesta' });
    const keys = Object.keys(config);
    await withTx(async (c) => {
      for (const key of keys) {
        await c.query(
          `INSERT INTO scheduler_config (branch_code, config_key, config_value, updated_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (branch_code, config_key)
           DO UPDATE SET config_value=EXCLUDED.config_value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [branch_code, key, JSON.stringify(config[key]), req.user.username]
        );
      }
    });
    await audit(req, 'config', null, 'update', `Config import ${branch_code}: ${keys.length} keys`);
    res.json({ ok: true, imported: keys.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// FULL MONTH SNAPSHOT  (replaces the single localStorage.getItem(lsKey(YM)) call)
// GET /api/scheduler/month?month=YYYY-MM&branch=DLO1
// Returns { drivers, schedule, forecasts, config } — exactly the shape of state{}
// ─────────────────────────────────────────────────────────
router.get('/month', async (req, res) => {
  try {
    const month = monthStart(req.query.month);
    const branch = req.query.branch || 'DLO1';
    const [drivers, entries, forecasts, config] = await Promise.all([
      pool.query(
        `SELECT id, cognome, nome, filiale, service, contratto, ctr_type, expiry_date,
                work_days, default_code, status, transporter_id, device, hire_date, employee_id
           FROM scheduler_drivers WHERE filiale=$1 AND status != 'pending'
          ORDER BY cognome, nome`, [branch]),
      pool.query(
        `SELECT employee_id, local_driver_id, day_of_month, shift_code
           FROM schedule_entries WHERE schedule_month=$1 AND branch_code=$2`, [month, branch]),
      pool.query(
        `SELECT service_key, day_of_month, qty
           FROM schedule_forecasts WHERE schedule_month=$1 AND branch_code=$2`, [month, branch]),
      pool.query(
        `SELECT config_key, config_value FROM scheduler_config WHERE branch_code=$1`, [branch]),
    ]);

    // Reconstruct the state{} shape the scheduler expects
    const scheduleMap = {};
    for (const r of entries.rows) {
      const did = r.employee_id || r.local_driver_id;
      if (!scheduleMap[did]) scheduleMap[did] = {};
      scheduleMap[did][r.day_of_month] = r.shift_code;
    }
    const forecastMap = {};
    for (const r of forecasts.rows) {
      if (!forecastMap[r.service_key]) forecastMap[r.service_key] = {};
      forecastMap[r.service_key][r.day_of_month] = r.qty;
    }
    const configMap = {};
    for (const r of config.rows) configMap[r.config_key] = r.config_value;

    res.json({
      meta: { month: req.query.month, branch, source: 'postgresql' },
      drivers: drivers.rows,
      schedule: scheduleMap,
      forecast: forecastMap,
      config: configMap,
    });
  } catch (e) { console.error('month snapshot:', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/scheduler/month/import  — import a full localStorage JSON dump
// Body: the raw state{} object as exported from the scheduler (JSON export)
router.post('/month/import', requirePermission('schedule.manage'), async (req, res) => {
  try {
    const { month, branch_code = 'DLO1', state: st } = req.body || {};
    if (!st || !month) return res.status(400).json({ error: 'month e state richiesti' });
    const m = monthStart(month);
    let drivers = 0, cells = 0, fc = 0;

    await withTx(async (c) => {
      // Import drivers
      if (st.drivers) {
        for (const d of st.drivers) {
          const { rows } = await c.query(
            `INSERT INTO scheduler_drivers
               (cognome, nome, filiale, service, contratto, ctr_type, expiry_date,
                work_days, default_code, status, transporter_id, device, hire_date, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT DO NOTHING RETURNING id`,
            [d.cognome||'', d.nome||'', d.filiale||branch_code, d.service||null,
             d.contratto||null, d.ctrType||'indeterminato', d.expiry||null,
             d.workDays||[1,2,3,4,5], d.defaultCode||null, d.status||'active',
             d.transporterId||null, d.device||null, d.hireDate||null, req.user.username]
          );
          if (rows[0]) { d._dbId = rows[0].id; drivers++; }
        }
      }
      // Import schedule cells
      if (st.schedule) {
        for (const [rawId, days] of Object.entries(st.schedule)) {
          const driver = st.drivers && st.drivers.find(d => String(d.id) === rawId);
          const locId = driver?._dbId || null;
          for (const [day, code] of Object.entries(days)) {
            if (!code) continue;
            await c.query(
              `INSERT INTO schedule_entries
                 (schedule_month, local_driver_id, day_of_month, shift_code, branch_code, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (local_driver_id, schedule_month, day_of_month) WHERE local_driver_id IS NOT NULL
               DO UPDATE SET shift_code=EXCLUDED.shift_code, updated_by=EXCLUDED.updated_by, updated_at=now()`,
              [m, locId, +day, code, branch_code, req.user.username]
            );
            cells++;
          }
        }
      }
      // Import forecast
      if (st.forecast) {
        for (const [svcKey, days] of Object.entries(st.forecast)) {
          for (const [day, qty] of Object.entries(days)) {
            await c.query(
              `INSERT INTO schedule_forecasts
                 (schedule_month, branch_code, service_key, day_of_month, qty, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (schedule_month, branch_code, service_key, day_of_month)
               DO UPDATE SET qty=EXCLUDED.qty, updated_by=EXCLUDED.updated_by, updated_at=now()`,
              [m, branch_code, svcKey, +day, +qty || 0, req.user.username]
            );
            fc++;
          }
        }
      }
      // Import config
      if (st.config) {
        for (const [key, val] of Object.entries(st.config)) {
          await c.query(
            `INSERT INTO scheduler_config (branch_code, config_key, config_value, updated_by)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (branch_code, config_key)
             DO UPDATE SET config_value=EXCLUDED.config_value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [branch_code, key, JSON.stringify(val), req.user.username]
          );
        }
      }
    });
    await audit(req, 'schedule', null, 'create', `Import localStorage ${m} ${branch_code}: ${drivers} drivers, ${cells} celle, ${fc} forecast`);
    res.json({ ok: true, drivers, cells, forecasts: fc });
  } catch (e) { console.error('month import:', e.message); res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────

// GET /api/scheduler/log?month=YYYY-MM&branch=DLO1&limit=200
router.get('/log', async (req, res) => {
  try {
    const params = [];
    let sql = 'SELECT * FROM schedule_audit_log WHERE 1=1';
    if (req.query.month) { params.push(monthStart(req.query.month)); sql += ` AND schedule_month=$${params.length}`; }
    if (req.query.branch) { params.push(req.query.branch); sql += ` AND branch_code=$${params.length}`; }
    params.push(Math.min(+(req.query.limit || 200), 1000));
    sql += ` ORDER BY logged_at DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
