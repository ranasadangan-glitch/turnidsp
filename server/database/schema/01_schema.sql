-- ============================================================
-- TurniDSP Workforce Management Platform — PostgreSQL schema
-- All modules: employees, scheduling, teams, forecast, absences,
-- disciplinary, documents/expiry, audit log, users/auth.
-- Idempotent-ish: safe to run on a fresh database.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- ---------- reference / org structure ----------

CREATE TABLE IF NOT EXISTS branches (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,            -- e.g. DLO1, DLO7
  name          TEXT NOT NULL,
  address       TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- parking / convocation points per branch (multiple)
CREATE TABLE IF NOT EXISTS parking_points (
  id            SERIAL PRIMARY KEY,
  branch_id     INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  address       TEXT,
  meet_time     TEXT,                            -- "09:00"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- service types (Same A/B/C/E, Cargo, Rescue, Extra, ...)
CREATE TABLE IF NOT EXISTS service_types (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,            -- SAMEA, CARGO, RESCUE...
  name          TEXT NOT NULL,                   -- "Same A"
  default_shift_code TEXT,                       -- maps to a shift_code
  meet_time     TEXT,                            -- per-service convocation
  parking_name  TEXT,                            -- Luogo Convocazione
  color         TEXT,                            -- hex for UI
  sort_order    INT DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- shift / absence codes (the "legenda": X, SameA, OFF, M, F, ...)
CREATE TABLE IF NOT EXISTS shift_codes (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'next',    -- next|samea|sameb|mm|abs|off|mal
  is_work       BOOLEAN NOT NULL DEFAULT TRUE,   -- counts as worked day
  is_absence    BOOLEAN NOT NULL DEFAULT FALSE,
  is_off        BOOLEAN NOT NULL DEFAULT FALSE,
  color         TEXT
);

CREATE TABLE IF NOT EXISTS contract_types (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,            -- e.g. "21", "13"
  label         TEXT NOT NULL,                   -- "Full-time 40h"
  weekly_hours  NUMERIC(5,2) NOT NULL DEFAULT 40,
  default_days  INT DEFAULT 5
);

-- ---------- teams & leaders ----------

CREATE TABLE IF NOT EXISTS teams (
  id            SERIAL PRIMARY KEY,
  branch_id     INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  team_leader_id INT,                            -- FK added after users
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, name)
);

-- ---------- users / auth (admin + team leaders) ----------

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                   -- bcrypt
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'team_leader', -- admin|team_leader
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- which branches a user can access (team leaders may cover several)
CREATE TABLE IF NOT EXISTS user_branches (
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id     INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

-- which teams a user (team leader) manages
CREATE TABLE IF NOT EXISTS user_teams (
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id       INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, team_id)
);

-- which service forecasts a user can manage (optional scoping)
CREATE TABLE IF NOT EXISTS user_services (
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_type_id INT NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, service_type_id)
);

ALTER TABLE teams
  DROP CONSTRAINT IF EXISTS teams_team_leader_fk,
  ADD CONSTRAINT teams_team_leader_fk
  FOREIGN KEY (team_leader_id) REFERENCES users(id) ON DELETE SET NULL;

-- ---------- employees (drivers / DAS) ----------

CREATE TABLE IF NOT EXISTS employees (
  id              SERIAL PRIMARY KEY,
  employee_code   TEXT UNIQUE,                   -- internal Employee ID
  transporter_id  TEXT,                          -- Amazon Transporter ID
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  device          TEXT,                          -- assigned phone/device
  branch_id       INT REFERENCES branches(id) ON DELETE SET NULL,
  team_id         INT REFERENCES teams(id) ON DELETE SET NULL,
  service_type_id INT REFERENCES service_types(id) ON DELETE SET NULL,
  contract_type_id INT REFERENCES contract_types(id) ON DELETE SET NULL,
  weekly_hours    NUMERIC(5,2),
  default_shift_code TEXT,
  work_days       INT[] DEFAULT '{1,2,3,4,5}',   -- ISO weekdays 1=Mon..7=Sun
  hire_date       DATE,
  contract_end_date DATE,
  status          TEXT NOT NULL DEFAULT 'active', -- active|inactive|pending
  added_by        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emp_branch ON employees(branch_id);
CREATE INDEX IF NOT EXISTS idx_emp_team   ON employees(team_id);
CREATE INDEX IF NOT EXISTS idx_emp_status ON employees(status);

-- ---------- scheduling ----------

-- one row per employee per day (the planned shift)
CREATE TABLE IF NOT EXISTS schedules (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date     DATE NOT NULL,
  shift_code    TEXT NOT NULL,                   -- references shift_codes.code
  note          TEXT,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_sched_date ON schedules(work_date);
CREATE INDEX IF NOT EXISTS idx_sched_emp  ON schedules(employee_id);

-- reusable shift templates (e.g. "Mon-Fri NEXT")
CREATE TABLE IF NOT EXISTS shift_templates (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  branch_id     INT REFERENCES branches(id) ON DELETE CASCADE,
  pattern       JSONB NOT NULL,                  -- {"1":"X","2":"X",...,"6":"OFF","7":"OFF"}
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- forecast ----------

CREATE TABLE IF NOT EXISTS forecasts (
  id              BIGSERIAL PRIMARY KEY,
  branch_id       INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  service_type_id INT NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,
  forecast_date   DATE NOT NULL,
  qty             INT NOT NULL DEFAULT 0,        -- forecast routes
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, service_type_id, forecast_date)
);
CREATE INDEX IF NOT EXISTS idx_fc_date ON forecasts(forecast_date);

-- ---------- absences ----------

CREATE TABLE IF NOT EXISTS absences (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  absence_type  TEXT NOT NULL,                   -- ferie|malattia|permesso|infortunio|...
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_abs_emp ON absences(employee_id);

-- ---------- disciplinary (warnings, suspensions, with PDFs) ----------

CREATE TABLE IF NOT EXISTS disciplinary_actions (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  action_type   TEXT NOT NULL,                   -- warning|suspension|note
  action_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  severity      TEXT DEFAULT 'low',              -- low|medium|high
  description   TEXT,
  document_path TEXT,                            -- uploaded PDF path
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_disc_emp ON disciplinary_actions(employee_id);

-- ---------- documents & expiry (contract, license, training) ----------

CREATE TABLE IF NOT EXISTS documents (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL,                   -- contract|driving_license|training|other
  number        TEXT,
  issue_date    DATE,
  expiry_date   DATE,
  file_path     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_expiry ON documents(expiry_date);

-- ---------- audit log ----------

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  username      TEXT,
  role          TEXT,
  entity        TEXT,                            -- schedule|employee|absence|disciplinary|user|config|auth
  entity_id     TEXT,
  action        TEXT,                            -- create|update|delete|login|logout|approve|...
  detail        TEXT,
  ip            TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity);

-- ---------- helper view: contract/doc expiry alerts ----------

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

-- updated_at trigger for employees
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_emp_updated ON employees;
CREATE TRIGGER trg_emp_updated BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
