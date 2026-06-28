const router = require('express').Router();
const { pool, withTx } = require('../db/pool');
const { auth, loadScope, audit } = require('../middleware/auth');

const { requirePermission } = require('../middleware/rbac');
router.use(auth, loadScope);

// GET /api/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD&branch=
// Returns one row per (employee, date) with a code.
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from/to richiesti' });
  const params = [from, to];
  let sql = `SELECT s.employee_id, s.work_date, s.shift_code
               FROM schedules s JOIN employees e ON e.id=s.employee_id
              WHERE s.work_date BETWEEN $1 AND $2`;
  if (!req.scope.admin) {
    if (!req.scope.branches.length) return res.json([]);
    params.push(req.scope.branches);
    sql += ` AND e.branch_id = ANY($${params.length})`;
  }
  if (req.query.branch) { params.push(req.query.branch); sql += ` AND e.branch_id=(SELECT id FROM branches WHERE code=$${params.length})`; }
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// PUT /api/schedules  { employee_id, work_date, shift_code }  (upsert; '' or null deletes)
router.put('/', requirePermission('schedule.manage'), async (req, res) => {
  const { employee_id, work_date, shift_code } = req.body || {};
  if (!employee_id || !work_date) return res.status(400).json({ error: 'Dati mancanti' });
  if (!shift_code) {
    await pool.query('DELETE FROM schedules WHERE employee_id=$1 AND work_date=$2', [employee_id, work_date]);
  } else {
    await pool.query(
      `INSERT INTO schedules (employee_id, work_date, shift_code, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id, work_date)
       DO UPDATE SET shift_code=EXCLUDED.shift_code, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [employee_id, work_date, shift_code, req.user.username]
    );
  }
  await audit(req, 'schedule', employee_id, 'update', `${work_date}: ${shift_code || 'vuoto'}`);
  res.json({ ok: true });
});

// POST /api/schedules/bulk  { items:[{employee_id, work_date, shift_code}] }
router.post('/bulk', requirePermission('schedule.manage'), async (req, res) => {
  const items = (req.body && req.body.items) || [];
  await withTx(async (c) => {
    for (const it of items) {
      if (!it.shift_code) {
        await c.query('DELETE FROM schedules WHERE employee_id=$1 AND work_date=$2', [it.employee_id, it.work_date]);
      } else {
        await c.query(
          `INSERT INTO schedules (employee_id, work_date, shift_code, updated_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (employee_id, work_date)
           DO UPDATE SET shift_code=EXCLUDED.shift_code, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [it.employee_id, it.work_date, it.shift_code, req.user.username]
        );
      }
    }
  });
  await audit(req, 'schedule', null, 'update', `Assegnazione massiva (${items.length})`);
  res.json({ ok: true, count: items.length });
});

// POST /api/schedules/copy  { from_start, to_start, days }  copies a block forward
// Copies the `days` starting at from_start onto the block starting at to_start.
router.post('/copy', requirePermission('schedule.manage'), async (req, res) => {
  const { from_start, to_start, days } = req.body || {};
  if (!from_start || !to_start || !days) return res.status(400).json({ error: 'Parametri mancanti' });
  const src = await pool.query(
    `SELECT employee_id, work_date, shift_code FROM schedules
      WHERE work_date >= $1 AND work_date < ($1::date + $2::int)`,
    [from_start, days]
  );
  const offset = (new Date(to_start) - new Date(from_start)) / 86400000;
  await withTx(async (c) => {
    for (const r of src.rows) {
      const nd = new Date(r.work_date); nd.setDate(nd.getDate() + offset);
      const iso = nd.toISOString().slice(0, 10);
      await c.query(
        `INSERT INTO schedules (employee_id, work_date, shift_code, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (employee_id, work_date)
         DO UPDATE SET shift_code=EXCLUDED.shift_code, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [r.employee_id, iso, r.shift_code, req.user.username]
      );
    }
  });
  await audit(req, 'schedule', null, 'update', `Copia turni ${from_start}→${to_start} (${days}g)`);
  res.json({ ok: true, copied: src.rows.length });
});

// ---- shift templates ----
router.get('/templates', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shift_templates ORDER BY name');
  res.json(rows);
});
router.post('/templates', requirePermission('schedule.manage'), async (req, res) => {
  const { name, branch_id, pattern } = req.body || {};
  const { rows } = await pool.query(
    'INSERT INTO shift_templates (name, branch_id, pattern, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
    [name, branch_id || null, pattern, req.user.username]
  );
  await audit(req, 'config', rows[0].id, 'create', 'Template turni: ' + name);
  res.status(201).json(rows[0]);
});

module.exports = router;
