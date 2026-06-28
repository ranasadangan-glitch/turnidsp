// GET /api/search?q=query&limit=20
// Global search across employees, documents, absences, audit log.

const router = require('express').Router();
const { pool } = require('../db/pool');
const { auth, loadScope } = require('../middleware/auth');

router.use(auth, loadScope);

function branchFilter(scope, params, col = 'e.branch_id') {
  if (scope.admin) return '';
  if (!scope.branches.length) return ' AND 1=0';
  params.push(scope.branches);
  return ` AND ${col} = ANY($${params.length})`;
}

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ results: [] });

  const limit = Math.min(50, +(req.query.limit || 20));
  const results = [];

  try {
    // ── Employees (full-text + ilike fallback) ──────────────────
    const empParams = ['%' + q.toLowerCase() + '%'];
    const empBranch = branchFilter(req.scope, empParams);
    const empRows = await pool.query(
      `SELECT e.id, e.first_name, e.last_name, e.employee_code, e.transporter_id,
              e.status, b.code AS branch_code, st.name AS service_name
         FROM employees e
         LEFT JOIN branches b ON b.id = e.branch_id
         LEFT JOIN service_types st ON st.id = e.service_type_id
        WHERE (lower(e.first_name || ' ' || e.last_name) LIKE $1
           OR lower(coalesce(e.transporter_id,'')) LIKE $1
           OR lower(coalesce(e.employee_code,'')) LIKE $1
           OR lower(coalesce(e.email,'')) LIKE $1)
          ${empBranch}
        ORDER BY e.last_name, e.first_name
        LIMIT ${limit}`,
      empParams
    );
    empRows.rows.forEach(r => results.push({
      type: 'employee',
      id: r.id,
      title: `${r.last_name} ${r.first_name}`,
      subtitle: [r.branch_code, r.service_name, r.transporter_id].filter(Boolean).join(' · '),
      status: r.status,
      url: `/employees.html#${r.id}`,
    }));

    // ── Documents ───────────────────────────────────────────────
    const docParams = ['%' + q.toLowerCase() + '%'];
    const docBranch = branchFilter(req.scope, docParams, 'e.branch_id');
    const docRows = await pool.query(
      `SELECT d.id, d.doc_type, d.number, d.expiry_date,
              e.first_name, e.last_name, e.id AS emp_id
         FROM documents d
         JOIN employees e ON e.id = d.employee_id
        WHERE (lower(coalesce(d.number,'')) LIKE $1
           OR lower(d.doc_type) LIKE $1
           OR lower(e.first_name||' '||e.last_name) LIKE $1)
          ${docBranch}
        ORDER BY d.expiry_date NULLS LAST
        LIMIT ${Math.ceil(limit / 2)}`,
      docParams
    );
    docRows.rows.forEach(r => results.push({
      type: 'document',
      id: r.id,
      title: `${r.doc_type}${r.number ? ' – ' + r.number : ''}`,
      subtitle: `${r.last_name} ${r.first_name}` + (r.expiry_date ? ` · Scade ${new Date(r.expiry_date).toLocaleDateString('it-IT')}` : ''),
      url: `/employees.html#${r.emp_id}`,
    }));

    // ── Absences ────────────────────────────────────────────────
    const absParams = ['%' + q.toLowerCase() + '%'];
    const absBranch = branchFilter(req.scope, absParams, 'e.branch_id');
    const absRows = await pool.query(
      `SELECT a.id, a.absence_type, a.start_date, a.end_date,
              e.first_name, e.last_name, e.id AS emp_id
         FROM absences a
         JOIN employees e ON e.id = a.employee_id
        WHERE (lower(e.first_name||' '||e.last_name) LIKE $1
           OR lower(a.absence_type) LIKE $1)
          ${absBranch}
        ORDER BY a.start_date DESC
        LIMIT ${Math.ceil(limit / 3)}`,
      absParams
    );
    absRows.rows.forEach(r => results.push({
      type: 'absence',
      id: r.id,
      title: `${r.absence_type}: ${r.last_name} ${r.first_name}`,
      subtitle: `${new Date(r.start_date).toLocaleDateString('it-IT')} → ${new Date(r.end_date).toLocaleDateString('it-IT')}`,
      url: `/employees.html#${r.emp_id}`,
    }));

  } catch (e) {
    console.error('search error:', e.message);
  }

  res.json({ results: results.slice(0, limit), query: q });
});

module.exports = router;
