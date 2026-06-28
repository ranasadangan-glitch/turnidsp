// /api/notifications — system alerts and user notifications
// Auto-generates contract/document expiry alerts when checked.

const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope } = require('../middleware/auth');

router.use(auth, loadScope);

// GET /api/notifications?unread=true&limit=50
// Returns notifications for the current user (or all broadcast ones for admin).
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(200, +(req.query.limit || 50));
    const unreadOnly = req.query.unread === 'true';
    const params = [req.user.id, limit];
    let where = `WHERE (n.user_id = $1 OR n.user_id IS NULL) AND n.dismissed = FALSE`;
    if (unreadOnly) where += ' AND n.read_at IS NULL';
    const { rows } = await pool.query(
      `SELECT n.*, e.first_name, e.last_name, b.code AS branch_code
         FROM notifications n
         LEFT JOIN employees e ON e.id = n.employee_id
         LEFT JOIN branches b ON b.id = e.branch_id
         ${where}
         ORDER BY n.created_at DESC LIMIT $2`,
      params
    );
    const unreadCount = rows.filter(r => !r.read_at).length;
    res.json({ rows, unread_count: unreadCount });
  } catch (e) {
    console.error('notifications GET:', e.message);
    res.status(500).json({ error: 'Errore notifiche' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read_at = now() WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read_at = now() WHERE (user_id = $1 OR user_id IS NULL) AND read_at IS NULL',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// DELETE /api/notifications/:id/dismiss
router.delete('/:id/dismiss', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET dismissed = TRUE WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// POST /api/notifications/refresh — generate/refresh system notifications
// Called on demand or by a cron. Safe to call multiple times (upsert-like).
router.post('/refresh', async (req, res) => {
  try {
    const generated = [];

    // 1. Contract expiry alerts
    const contracts = await pool.query(`
      SELECT e.id, e.first_name, e.last_name, e.contract_end_date,
             b.code AS branch_code, e.branch_id
        FROM employees e
        LEFT JOIN branches b ON b.id = e.branch_id
       WHERE e.status = 'active'
         AND e.contract_end_date IS NOT NULL
         AND e.contract_end_date >= CURRENT_DATE - 1
         AND e.contract_end_date <= CURRENT_DATE + 30
    `);

    for (const emp of contracts.rows) {
      const daysLeft = Math.ceil(
        (new Date(emp.contract_end_date) - new Date()) / 86400000
      );
      let severity = 'info';
      if (daysLeft < 0) severity = 'critical';
      else if (daysLeft <= 7) severity = 'critical';
      else if (daysLeft <= 15) severity = 'warning';

      const title = daysLeft < 0
        ? `Contratto scaduto: ${emp.last_name} ${emp.first_name}`
        : `Contratto in scadenza: ${emp.last_name} ${emp.first_name}`;
      const body = daysLeft < 0
        ? `Il contratto è scaduto il ${new Date(emp.contract_end_date).toLocaleDateString('it-IT')}`
        : `Scade tra ${daysLeft} giorni (${new Date(emp.contract_end_date).toLocaleDateString('it-IT')})`;

      // Only insert if not already present for this employee today
      const exists = await pool.query(
        `SELECT 1 FROM notifications WHERE employee_id=$1 AND category='contract'
          AND created_at > CURRENT_DATE::timestamptz AND dismissed=FALSE LIMIT 1`,
        [emp.id]
      );
      if (!exists.rowCount) {
        await pool.query(
          `INSERT INTO notifications (employee_id, category, severity, title, body, action_url)
           VALUES ($1, 'contract', $2, $3, $4, $5)`,
          [emp.id, severity, title, body, `/employees.html#${emp.id}`]
        );
        generated.push({ type: 'contract', employee_id: emp.id, severity });
      }
    }

    // 2. Document expiry alerts
    const docs = await pool.query(`
      SELECT d.id AS doc_id, d.doc_type, d.expiry_date,
             e.id AS emp_id, e.first_name, e.last_name
        FROM documents d
        JOIN employees e ON e.id = d.employee_id
       WHERE e.status = 'active'
         AND d.expiry_date IS NOT NULL
         AND d.expiry_date >= CURRENT_DATE - 1
         AND d.expiry_date <= CURRENT_DATE + 30
    `);

    for (const doc of docs.rows) {
      const daysLeft = Math.ceil(
        (new Date(doc.expiry_date) - new Date()) / 86400000
      );
      const severity = daysLeft <= 7 ? 'critical' : 'warning';
      const title = `Documento in scadenza: ${doc.last_name} ${doc.first_name}`;
      const body = `${doc.doc_type} scade tra ${daysLeft} giorni`;

      const exists = await pool.query(
        `SELECT 1 FROM notifications WHERE employee_id=$1 AND category='document'
          AND body ILIKE $2 AND created_at > CURRENT_DATE::timestamptz AND dismissed=FALSE LIMIT 1`,
        [doc.emp_id, `%${doc.doc_type}%`]
      );
      if (!exists.rowCount) {
        await pool.query(
          `INSERT INTO notifications (employee_id, category, severity, title, body, action_url)
           VALUES ($1, 'document', $2, $3, $4, $5)`,
          [doc.emp_id, severity, title, body, `/employees.html#${doc.emp_id}`]
        );
        generated.push({ type: 'document', employee_id: doc.emp_id });
      }
    }

    res.json({ ok: true, generated: generated.length, items: generated });
  } catch (e) {
    console.error('notifications refresh:', e.message);
    res.status(500).json({ error: 'Errore generazione notifiche' });
  }
});

module.exports = router;
