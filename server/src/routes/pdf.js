// PDF reports via PDFKit. All endpoints respect branch scope.
const router = require('express').Router();
const PDFDocument = require('pdfkit');
const { pool } = require('../db/pool');
const { auth, loadScope, audit } = require('../middleware/auth');
router.use(auth, loadScope);

function branchClause(scope, params, col) {
  if (scope.admin) return '';
  if (!scope.branches.length) return ' AND 1=0';
  params.push(scope.branches); return ` AND ${col} = ANY($${params.length})`;
}
function startPdf(res, filename, landscape) {
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}
function header(doc, title, subtitle) {
  doc.fillColor('#16233B').fontSize(16).font('Helvetica-Bold').text('TurniDSP — ' + title);
  if (subtitle) doc.fontSize(10).font('Helvetica').fillColor('#555').text(subtitle);
  doc.moveDown(0.5);
  doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - 36, doc.y).strokeColor('#16233B').stroke();
  doc.moveDown(0.6).fillColor('#111');
}
function row(doc, cols, widths, opts = {}) {
  const y = doc.y; let x = doc.x;
  doc.fontSize(opts.size || 9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
  cols.forEach((c, i) => {
    doc.fillColor(opts.color || '#111').text(String(c == null ? '' : c), x + 2, y + 2, { width: widths[i] - 4, ellipsis: true });
    x += widths[i];
  });
  doc.moveDown(0.2);
  const ny = doc.y;
  if (opts.line) { doc.moveTo(36, ny).lineTo(doc.page.width - 36, ny).strokeColor('#e0e0e0').stroke(); }
  doc.x = 36;
}
function ddmm(d) { const x = new Date(d); return String(x.getDate()).padStart(2, '0') + '/' + String(x.getMonth() + 1).padStart(2, '0'); }

// helper: list of dates between
function dateRange(from, days) {
  const out = []; const d = new Date(from);
  for (let i = 0; i < days; i++) { out.push(new Date(d).toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  return out;
}

// GET /api/pdf/schedule/weekly?from=YYYY-MM-DD&branch=
router.get('/schedule/weekly', async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const days = dateRange(from, 7);
  const params = [from, days[6]]; const bc = branchClause(req.scope, params, 'e.branch_id');
  let q = `SELECT e.id, e.last_name, e.first_name, b.code branch_code, s.work_date, s.shift_code
             FROM employees e JOIN branches b ON b.id=e.branch_id
             LEFT JOIN schedules s ON s.employee_id=e.id AND s.work_date BETWEEN $1 AND $2
            WHERE e.status='active' ${bc}`;
  if (req.query.branch) { params.push(req.query.branch); q += ` AND b.code=$${params.length}`; }
  q += ' ORDER BY e.last_name, e.first_name, s.work_date';
  const { rows } = await pool.query(q, params);
  const emp = {};
  for (const r of rows) { (emp[r.id] = emp[r.id] || { name: r.last_name + ' ' + r.first_name, days: {} }); if (r.work_date) emp[r.id].days[r.work_date.toISOString().slice(0,10)] = r.shift_code; }

  const doc = startPdf(res, `turnazione_settimanale_${from}.pdf`, true);
  header(doc, 'Turnazione settimanale', `${ddmm(days[0])} – ${ddmm(days[6])}` + (req.query.branch ? ` · ${req.query.branch}` : ''));
  const nameW = 150, dayW = (doc.page.width - 72 - nameW) / 7;
  row(doc, ['Dipendente', ...days.map(ddmm)], [nameW, ...days.map(() => dayW)], { bold: true, line: true });
  Object.values(emp).forEach(e => row(doc, [e.name, ...days.map(d => e.days[d] || '')], [nameW, ...days.map(() => dayW)], { line: true }));
  doc.end();
  await audit(req, 'schedule', null, 'export', 'PDF turnazione settimanale');
});

// GET /api/pdf/schedule/monthly?month=YYYY-MM&branch=
router.get('/schedule/monthly', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const ndays = new Date(y, m, 0).getDate();
  const from = `${month}-01`, to = `${month}-${String(ndays).padStart(2, '0')}`;
  const params = [from, to]; const bc = branchClause(req.scope, params, 'e.branch_id');
  let q = `SELECT e.id, e.last_name, e.first_name, b.code branch_code, s.work_date, s.shift_code
             FROM employees e JOIN branches b ON b.id=e.branch_id
             LEFT JOIN schedules s ON s.employee_id=e.id AND s.work_date BETWEEN $1 AND $2
            WHERE e.status='active' ${bc}`;
  if (req.query.branch) { params.push(req.query.branch); q += ` AND b.code=$${params.length}`; }
  q += ' ORDER BY e.last_name, e.first_name';
  const { rows } = await pool.query(q, params);
  const emp = {};
  for (const r of rows) { (emp[r.id] = emp[r.id] || { name: r.last_name + ' ' + r.first_name, days: {} }); if (r.work_date) emp[r.id].days[r.work_date.getDate()] = r.shift_code; }

  const doc = startPdf(res, `turnazione_mensile_${month}.pdf`, true);
  header(doc, 'Turnazione mensile', month + (req.query.branch ? ` · ${req.query.branch}` : ''));
  const nameW = 120, dayW = (doc.page.width - 72 - nameW) / ndays;
  row(doc, ['Dipendente', ...Array.from({ length: ndays }, (_, i) => i + 1)], [nameW, ...Array(ndays).fill(dayW)], { bold: true, size: 7, line: true });
  Object.values(emp).forEach(e => row(doc, [e.name, ...Array.from({ length: ndays }, (_, i) => e.days[i + 1] || '')], [nameW, ...Array(ndays).fill(dayW)], { size: 6, line: true }));
  doc.end();
  await audit(req, 'schedule', null, 'export', 'PDF turnazione mensile');
});

// GET /api/pdf/absences?from=&to=&branch=
router.get('/absences', async (req, res) => {
  const { from, to } = req.query; if (!from || !to) return res.status(400).json({ error: 'from/to richiesti' });
  const params = [from, to]; const bc = branchClause(req.scope, params, 'e.branch_id');
  const { rows } = await pool.query(
    `SELECT e.last_name,e.first_name,b.code branch_code,a.absence_type,a.start_date,a.end_date,a.note
       FROM absences a JOIN employees e ON e.id=a.employee_id JOIN branches b ON b.id=e.branch_id
      WHERE a.start_date <= $2 AND a.end_date >= $1 ${bc} ORDER BY a.start_date`, params);
  const doc = startPdf(res, `report_assenze_${from}_${to}.pdf`);
  header(doc, 'Report assenze', `${from} – ${to}`);
  const w = [150, 60, 90, 80, 80];
  row(doc, ['Dipendente', 'Filiale', 'Tipo', 'Dal', 'Al'], w, { bold: true, line: true });
  rows.forEach(r => row(doc, [r.last_name + ' ' + r.first_name, r.branch_code, r.absence_type, ddmm(r.start_date), ddmm(r.end_date)], w, { line: true }));
  if (!rows.length) doc.text('Nessuna assenza nel periodo.');
  doc.end();
  await audit(req, 'absence', null, 'export', 'PDF report assenze');
});

// GET /api/pdf/disciplinary?from=&to=&branch=
router.get('/disciplinary', async (req, res) => {
  const { from, to } = req.query; if (!from || !to) return res.status(400).json({ error: 'from/to richiesti' });
  const params = [from, to]; const bc = branchClause(req.scope, params, 'e.branch_id');
  const { rows } = await pool.query(
    `SELECT e.last_name,e.first_name,b.code branch_code,d.action_type,d.severity,d.action_date,d.archived,d.description
       FROM disciplinary_actions d JOIN employees e ON e.id=d.employee_id JOIN branches b ON b.id=e.branch_id
      WHERE d.action_date BETWEEN $1 AND $2 ${bc} ORDER BY d.action_date DESC`, params);
  const doc = startPdf(res, `report_disciplinare_${from}_${to}.pdf`);
  header(doc, 'Report disciplinare', `${from} – ${to}`);
  const w = [140, 55, 70, 60, 70, 110];
  row(doc, ['Dipendente', 'Filiale', 'Tipo', 'Gravità', 'Data', 'Stato'], w, { bold: true, line: true });
  rows.forEach(r => row(doc, [r.last_name + ' ' + r.first_name, r.branch_code, r.action_type, r.severity, ddmm(r.action_date), r.archived ? 'Archiviato' : 'Aperto'], w, { line: true }));
  if (!rows.length) doc.text('Nessun provvedimento nel periodo.');
  doc.end();
  await audit(req, 'disciplinary', null, 'export', 'PDF report disciplinare');
});

// GET /api/pdf/forecast?from=&to=&branch=
router.get('/forecast', async (req, res) => {
  const { from, to } = req.query; if (!from || !to) return res.status(400).json({ error: 'from/to richiesti' });
  const params = [from, to]; const bc = branchClause(req.scope, params, 'f.branch_id');
  const { rows } = await pool.query(
    `SELECT b.code branch_code, st.name service, f.forecast_date, f.qty
       FROM forecasts f JOIN branches b ON b.id=f.branch_id JOIN service_types st ON st.id=f.service_type_id
      WHERE f.forecast_date BETWEEN $1 AND $2 ${bc} ORDER BY f.forecast_date, st.name`, params);
  const doc = startPdf(res, `report_forecast_${from}_${to}.pdf`);
  header(doc, 'Report forecast', `${from} – ${to}`);
  const w = [80, 140, 90, 60];
  row(doc, ['Filiale', 'Service', 'Data', 'Qtà'], w, { bold: true, line: true });
  rows.forEach(r => row(doc, [r.branch_code, r.service, ddmm(r.forecast_date), r.qty], w, { line: true }));
  if (!rows.length) doc.text('Nessun forecast nel periodo.');
  doc.end();
  await audit(req, 'config', null, 'export', 'PDF report forecast');
});

module.exports = router;
