-- ============================================================
-- 07 — Workforce Platform additions (additive, idempotent)
--   * notifications (system-generated alerts for contract/docs/schedule)
--   * v_employee_profile (full-detail view used by the profile page)
--   * full-text search column on employees (tsvector)
--   * employees extra fields: emergency contact, notes, photo_url
-- ============================================================

-- ── Extra fields on employees (all additive) ──────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_name TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_phone TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS nationality TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tax_code TEXT;

-- Full-text search vector (regenerated on upsert trigger below)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Trigger to keep search_vector in sync
CREATE OR REPLACE FUNCTION update_emp_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.last_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.first_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.transporter_id,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.employee_code,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.email,'')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.phone,'')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_emp_search ON employees;
CREATE TRIGGER trg_emp_search BEFORE INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_emp_search_vector();

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_emp_search_vec ON employees USING gin(search_vector);

-- ── Notifications ──────────────────────────────────────────────
-- System-generated and user-facing alert notifications.
-- Severity: info|warning|critical
-- category: contract|document|schedule|system|absence|disciplinary
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE CASCADE,  -- NULL = broadcast to all admins
  employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
  category    TEXT NOT NULL DEFAULT 'system',
  severity    TEXT NOT NULL DEFAULT 'info',   -- info|warning|critical
  title       TEXT NOT NULL,
  body        TEXT,
  action_url  TEXT,                           -- relative URL to navigate to
  read_at     TIMESTAMPTZ,
  dismissed   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread  ON notifications(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_emp     ON notifications(employee_id);

-- ── Employee profile view ──────────────────────────────────────
-- One-stop view used by the employee profile page.
CREATE OR REPLACE VIEW v_employee_profile AS
SELECT
  e.*,
  b.code  AS branch_code,
  b.name  AS branch_name,
  t.name  AS team_name,
  st.name AS service_type_name,
  st.code AS service_type_code,
  ct.label AS contract_label,
  ct.weekly_hours AS contract_weekly_hours,
  -- Contract urgency
  CASE
    WHEN e.contract_end_date IS NULL THEN 'permanent'
    WHEN e.contract_end_date < CURRENT_DATE THEN 'expired'
    WHEN e.contract_end_date < CURRENT_DATE + 7  THEN 'critical'
    WHEN e.contract_end_date < CURRENT_DATE + 30 THEN 'warning'
    ELSE 'ok'
  END AS contract_status,
  -- Days until contract expiry (NULL = permanent)
  (e.contract_end_date - CURRENT_DATE)::int AS contract_days_left,
  -- Count of active absences covering today
  (SELECT count(*) FROM absences a
   WHERE a.employee_id = e.id AND CURRENT_DATE BETWEEN a.start_date AND a.end_date
  )::int AS absences_today,
  -- Count of unread/open disciplinary
  (SELECT count(*) FROM disciplinary_actions d
   WHERE d.employee_id = e.id AND d.archived = FALSE
  )::int AS open_disciplinary,
  -- Count of documents on file
  (SELECT count(*) FROM documents doc WHERE doc.employee_id = e.id)::int AS doc_count,
  -- Months of tenure
  CASE WHEN e.hire_date IS NOT NULL
    THEN EXTRACT(MONTH FROM AGE(CURRENT_DATE, e.hire_date)) +
         EXTRACT(YEAR  FROM AGE(CURRENT_DATE, e.hire_date)) * 12
    ELSE NULL
  END::int AS tenure_months
FROM employees e
LEFT JOIN branches      b  ON b.id  = e.branch_id
LEFT JOIN teams         t  ON t.id  = e.team_id
LEFT JOIN service_types st ON st.id = e.service_type_id
LEFT JOIN contract_types ct ON ct.id = e.contract_type_id;

-- ── Shift templates: add color + description ─────────────────
ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#3B82F6';
