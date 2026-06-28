-- ============================================================
-- 04 — Performance optimization indexes (additive, idempotent)
-- Targets 500+ employees, 40+ team leaders, fast search & filters.
-- ============================================================

-- Trigram search on employee names (fast ILIKE / fuzzy search)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_emp_name_trgm
  ON employees USING gin ((lower(first_name || ' ' || last_name)) gin_trgm_ops);

-- Common filter combinations
CREATE INDEX IF NOT EXISTS idx_emp_branch_status ON employees(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_emp_team_status   ON employees(team_id, status);

-- Schedules: composite for range scans by branch via employee join is covered by
-- existing idx_sched_date + idx_sched_emp; add code filter helper
CREATE INDEX IF NOT EXISTS idx_sched_code ON schedules(shift_code);

-- Forecast lookups by branch+service over a date range
CREATE INDEX IF NOT EXISTS idx_fc_branch_service ON forecasts(branch_id, service_type_id, forecast_date);

-- Absences by date range (overlap queries)
CREATE INDEX IF NOT EXISTS idx_abs_dates ON absences(start_date, end_date);

-- Disciplinary open-case dashboards
CREATE INDEX IF NOT EXISTS idx_disc_open ON disciplinary_actions(archived, action_type);

-- Audit log filter by username
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(username);

ANALYZE employees;
ANALYZE schedules;
ANALYZE forecasts;
