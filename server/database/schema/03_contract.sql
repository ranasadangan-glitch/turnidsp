-- ============================================================
-- 03 — Contract management additions (additive, idempotent)
-- ============================================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS contract_start_date DATE;

CREATE INDEX IF NOT EXISTS idx_emp_contract_end ON employees(contract_end_date)
  WHERE contract_end_date IS NOT NULL;

-- Refresh the expiry view to also report contract start (kept backward-compatible)
CREATE OR REPLACE VIEW v_expiry_alerts AS
  SELECT e.id AS employee_id,
         e.first_name, e.last_name, e.branch_id,
         'contract'::text AS kind,
         e.contract_end_date AS expiry_date
    FROM employees e
   WHERE e.contract_end_date IS NOT NULL AND e.status = 'active'
  UNION ALL
  SELECT d.employee_id, e.first_name, e.last_name, e.branch_id,
         d.doc_type AS kind, d.expiry_date
    FROM documents d JOIN employees e ON e.id = d.employee_id
   WHERE d.expiry_date IS NOT NULL AND e.status = 'active';
