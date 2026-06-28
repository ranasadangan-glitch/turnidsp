const router = require('express').Router();
const path = require('path'); const fs = require('fs'); const multer = require('multer');
const { pool } = require('../db/pool');
const { auth, loadScope, audit } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { scanFile } = require('../middleware/antivirus');

const UP = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR, 'documents')
  : path.resolve(__dirname, '../../uploads/documents');
fs.mkdirSync(UP, { recursive: true });

// (9) File-type allow-list + size cap. Only documents we expect.
const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, UP),
    filename: (_r, f, cb) => cb(null, Date.now() + '_' + f.originalname.replace(/[^\w.\-]/g, '_')),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(null, ALLOWED.has(f.mimetype)),
});

router.use(auth, loadScope);

// list (view permission)
router.get('/', requirePermission('document.view'), async (req, res) => {
  const params = [];
  let sql = 'SELECT d.* FROM documents d WHERE 1=1';
  if (req.query.employee_id) { params.push(req.query.employee_id); sql += ` AND d.employee_id=$${params.length}`; }
  sql += ' ORDER BY d.expiry_date NULLS LAST';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// upload (manage permission) + virus scan hook
router.post('/', requirePermission('document.manage'), upload.single('file'), async (req, res) => {
  try {
    if (req.body && req.body._rejected) return res.status(415).json({ error: 'Tipo di file non consentito' });
    if (req.file) {
      const scan = await scanFile(path.join(UP, req.file.filename));
      if (!scan.clean) {
        fs.unlink(path.join(UP, req.file.filename), () => {});
        return res.status(422).json({ error: 'File rifiutato dal controllo antivirus' });
      }
    }
    const { employee_id, doc_type, number, issue_date, expiry_date } = req.body || {};
    const fp = req.file ? '/uploads/documents/' + req.file.filename : null;
    const { rows } = await pool.query(
      `INSERT INTO documents (employee_id,doc_type,number,issue_date,expiry_date,file_path)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employee_id, doc_type, number || null, issue_date || null, expiry_date || null, fp]);
    await audit(req, 'document', rows[0].id, 'create', `Documento ${doc_type} caricato (emp ${employee_id})`);
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('document upload error:', e.message);
    res.status(500).json({ error: 'Errore caricamento documento' });
  }
});

module.exports = router;
