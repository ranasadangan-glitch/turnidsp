const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope } = require('../middleware/auth');
router.use(auth, loadScope);

// GET /api/alerts/expiry?days=60  -> contract + license + training expiries within N days
router.get('/expiry', async (req, res) => {
  const days = +(req.query.days || 60);
  const params = [days];
  let sql = `SELECT * FROM v_expiry_alerts
              WHERE expiry_date <= (CURRENT_DATE + $1::int)`;
  if (!req.scope.admin) {
    if (!req.scope.branches.length) return res.json([]);
    params.push(req.scope.branches); sql += ` AND branch_id = ANY($${params.length})`;
  }
  sql += ' ORDER BY expiry_date';
  const { rows } = await pool.query(sql, params);
  // tag overdue/soon
  const today = new Date();
  res.json(rows.map(r => {
    const d = new Date(r.expiry_date);
    const diff = Math.round((d - today) / 86400000);
    return { ...r, days_left: diff, level: diff < 0 ? 'overdue' : diff <= 15 ? 'critical' : diff <= 30 ? 'warning' : 'info' };
  }));
});

module.exports = router;
