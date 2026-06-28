-- ============================================================
-- 06 — Scheduler localStorage → PostgreSQL
-- Stores everything the scheduler previously kept in the browser:
--   schedule cells   → schedule_entries  (already partially in schedules; extended)
--   forecast grid    → schedule_forecasts (per service key + day)
--   driver roster    → links to employees (already exists); scheduler-specific fields
--   shift config     → scheduler_config  (filiali, codes, services, contracts, counters)
--   action log       → schedule_audit_log
-- All tables are idempotent (IF NOT EXISTS / IF NOT EXISTS column).
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. SCHEDULE ENTRIES (the shift grid)
--    One row per driver × calendar day.
--    Maps to the scheduler's:  state.schedule[driver_id][day_of_month] = code
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_entries (
  id              BIGSERIAL PRIMARY KEY,
  -- The month this entry belongs to (YYYY-MM).  Stored as the first day of the month.
  schedule_month  DATE NOT NULL,
  -- Links to employees.id. NULL allowed so scheduler-only drivers (not yet in employees)
  -- can be referenced by local_driver_id instead.
  employee_id     INT REFERENCES employees(id) ON DELETE SET NULL,
  -- Fallback for drivers that live only in the scheduler roster (pre-migration).
  local_driver_id INT,
  -- Day of month (1..31)
  day_of_month    SMALLINT NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  -- The shift code (X, SameA, OFF, F, M, …)
  shift_code      TEXT NOT NULL,
  -- Denormalized for fast grid queries without joining employees every time
  branch_code     TEXT,
  -- Who last wrote this cell and when (audit)
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One cell per driver per month-day (either employee_id or local_driver_id)
  UNIQUE NULLS NOT DISTINCT (employee_id, schedule_month, day_of_month),
  UNIQUE NULLS NOT DISTINCT (local_driver_id, schedule_month, day_of_month)
);
CREATE INDEX IF NOT EXISTS idx_se_month        ON schedule_entries(schedule_month);
CREATE INDEX IF NOT EXISTS idx_se_employee     ON schedule_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_se_local_driver ON schedule_entries(local_driver_id);
CREATE INDEX IF NOT EXISTS idx_se_branch       ON schedule_entries(branch_code, schedule_month);

-- ─────────────────────────────────────────────
-- 2. SCHEDULER DRIVERS (local roster, pre-employee-link)
--    Maps to state.drivers[] in the scheduler.
--    When a driver is "approved" they get an employees row and
--    this row's employee_id FK is filled in.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduler_drivers (
  id              SERIAL PRIMARY KEY,
  employee_id     INT REFERENCES employees(id) ON DELETE SET NULL,
  cognome         TEXT NOT NULL,
  nome            TEXT NOT NULL,
  filiale         TEXT NOT NULL DEFAULT 'DLO1',
  service         TEXT,
  contratto       TEXT,
  ctr_type        TEXT DEFAULT 'indeterminato',   -- indeterminato | determinato
  expiry_date     DATE,
  work_days       INT[] DEFAULT '{1,2,3,4,5}',    -- ISO weekdays 1=Mon..7=Sun
  default_code    TEXT,
  status          TEXT NOT NULL DEFAULT 'active', -- active | inactive | pending
  transporter_id  TEXT,
  device          TEXT,
  hire_date       DATE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sd_branch ON scheduler_drivers(filiale);
CREATE INDEX IF NOT EXISTS idx_sd_status ON scheduler_drivers(status);

-- ─────────────────────────────────────────────
-- 3. SCHEDULE FORECASTS
--    Maps to state.forecast[service_key][day_of_month] = qty
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_forecasts (
  id              BIGSERIAL PRIMARY KEY,
  schedule_month  DATE NOT NULL,
  branch_code     TEXT NOT NULL DEFAULT 'DLO1',
  service_key     TEXT NOT NULL,   -- e.g. "SAMEA", "DLO1_NEXT", "SAMEE"
  day_of_month    SMALLINT NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  qty             INT NOT NULL DEFAULT 0,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_month, branch_code, service_key, day_of_month)
);
CREATE INDEX IF NOT EXISTS idx_sf_month   ON schedule_forecasts(schedule_month);
CREATE INDEX IF NOT EXISTS idx_sf_branch  ON schedule_forecasts(branch_code, schedule_month);

-- ─────────────────────────────────────────────
-- 4. SCHEDULER CONFIG (per-branch, versioned)
--    Maps to state.config (filiali, codes, services, contracts, counters, …)
--    Stored as JSONB so the rich nested structure is preserved without
--    a schema migration per config field added in the frontend.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduler_config (
  id              SERIAL PRIMARY KEY,
  branch_code     TEXT NOT NULL,
  config_key      TEXT NOT NULL,   -- 'codes' | 'services' | 'contracts' | 'counters' | 'filDetails' | 'global'
  config_value    JSONB NOT NULL,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_code, config_key)
);

-- ─────────────────────────────────────────────
-- 5. SCHEDULE AUDIT LOG
--    Maps to state.log[] entries:  {t, u, a}
--    More structured than the generic audit_log for schedule-specific queries.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  schedule_month  DATE,
  branch_code     TEXT,
  actor           TEXT,            -- username
  action          TEXT NOT NULL,   -- free-text, matches scheduler logAction() strings
  driver_id       INT,             -- scheduler_drivers.id if relevant
  employee_id     INT,             -- employees.id if resolved
  day_of_month    SMALLINT,
  old_code        TEXT,
  new_code        TEXT,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sal_month ON schedule_audit_log(schedule_month);
CREATE INDEX IF NOT EXISTS idx_sal_actor ON schedule_audit_log(actor);

-- trigger: keep scheduler_drivers.updated_at current
CREATE OR REPLACE FUNCTION set_scheduler_driver_updated()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sd_updated ON scheduler_drivers;
CREATE TRIGGER trg_sd_updated
  BEFORE UPDATE ON scheduler_drivers
  FOR EACH ROW EXECUTE FUNCTION set_scheduler_driver_updated();
