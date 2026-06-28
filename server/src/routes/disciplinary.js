const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool } = require('../db/pool');
const { auth, loadScope, audit } = require('../middleware/auth');

const UP = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR, 'disciplinary')
  : path.resolve(__dirname, '../../uploads/disciplinary');
fs.mkdirSync(UP, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, UP),
    filename: (_r, f, cb) => cb(null, Date.now() + '_' + f.originalname.replace(/[^\w.\-]/g, '_')),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(null, f.mimetype === 'application/pdf'),
});

const { requirePermission } = require('../middleware/rbac');
router.use(auth, loadScope);

// GET /api/disciplinary?employee_id=&archived=
router.get('/', requirePermission('disciplinary.view'), async (req, res) => {
  const params = [];
  let sql = `SELECT d.*, e.first_name, e.last_name, e.branch_id
               FROM disciplinary_actions d JOIN employees e ON e.id=d.employee_id WHERE 1=1`;
  if (!req.scope.admin) {
    if (!req.scope.branches.length) return res.json([]);
    params.push(req.scope.branches); sql += ` AND e.branch_id = ANY($${params.length})`;
  }
  if (req.query.employee_id) { params.push(req.query.employee_id); sql += ` AND d.employee_id=$${params.length}`; }
  if (req.query.archived !== undefined) { params.push(req.query.archived === 'true'); sql += ` AND d.archived=$${params.length}`; }
  if (req.query.type) { params.push(req.query.type); sql += ` AND d.action_type=$${params.length}`; }
  sql += ' ORDER BY d.action_date DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// POST /api/disciplinary  (multipart: optional PDF "document")
router.post('/', requirePermission('disciplinary.manage'), upload.single('document'), async (req, res) => {
  const { employee_id, action_type, action_date, severity, description } = req.body || {};
  const docPath = req.file ? '/uploads/disciplinary/' + req.file.filename : null;
  const { rows } = await pool.query(
    `INSERT INTO disciplinary_actions (employee_id,action_type,action_date,severity,description,document_path,created_by)
     VALUES ($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7) RETURNING *`,
    [employee_id, action_type, action_date || null, severity || 'low', description || null, docPath, req.user.username]);
  await audit(req, 'disciplinary', rows[0].id, 'create', `${action_type} (emp ${employee_id})`);
  res.status(201).json(rows[0]);
});

// PATCH /api/disciplinary/:id/archive
router.patch('/:id/archive', requirePermission('disciplinary.manage'), async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE disciplinary_actions SET archived=NOT archived WHERE id=$1 RETURNING *', [req.params.id]);
  await audit(req, 'disciplinary', req.params.id, 'update', 'Archiviazione toggled');
  res.json(rows[0]);
});

module.exports = router;
