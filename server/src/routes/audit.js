const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, requireAdmin } = require('../middleware/auth');
router.use(auth, requireAdmin);

// GET /api/audit?entity=&q=&limit=200
router.get('/', async (req, res) => {
  const params = []; let sql = 'SELECT * FROM audit_log WHERE 1=1';
  if (req.query.entity) { params.push(req.query.entity); sql += ` AND entity=$${params.length}`; }
  if (req.query.q) { params.push('%'+req.query.q.toLowerCase()+'%'); sql += ` AND (lower(username||' '||action||' '||COALESCE(detail,'')) LIKE $${params.length})`; }
  params.push(Math.min(+(req.query.limit||200), 1000));
  sql += ` ORDER BY ts DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

module.exports = router;
