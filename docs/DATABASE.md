# Database Reference — TurniDSP Platform (PostgreSQL)

Run `database/schema/01_schema.sql` then `database/seeds/02_seed.sql` (or `run_all.sql`).

## Tables

- **branches** — `code, name, address, active`
- **parking_points** — multiple parking/convocation points per branch (`name, address, meet_time`)
- **service_types** — Same A/B/C/E, Cargo, Rescue, Extra (`code, name, default_shift_code, meet_time, parking_name, color`)
- **shift_codes** — the legend (`code, label, category, is_work, is_absence, is_off`)
- **contract_types** — `code, label, weekly_hours, default_days`
- **teams** — `branch_id, name, team_leader_id`
- **users** — `username, password_hash (bcrypt), full_name, role (admin|team_leader), active`
- **user_branches / user_teams / user_services** — RBAC scoping join tables
- **employees** — full record: `employee_code, transporter_id, first/last name, email, phone,
  device, branch_id, team_id, service_type_id, contract_type_id, weekly_hours,
  default_shift_code, work_days int[], hire_date, contract_end_date, status`
- **schedules** — one row per employee/day (`work_date, shift_code`), unique(employee_id, work_date)
- **shift_templates** — reusable weekly patterns (JSONB)
- **forecasts** — per branch/service/day route forecast, unique(branch, service, date)
- **absences** — `absence_type, start_date, end_date`
- **disciplinary_actions** — warnings/suspensions, `severity, document_path (PDF), archived`
- **documents** — `doc_type (contract|driving_license|training|other), expiry_date, file_path`
- **audit_log** — `ts, username, role, entity, entity_id, action, detail, ip`

## Views
- **v_expiry_alerts** — unifies contract + document expiries for the alerts module.

## Notable indexes
- `schedules(work_date)`, `schedules(employee_id)`
- `forecasts(forecast_date)`
- `employees(branch_id|team_id|status)`
- `audit_log(ts|entity)`, `documents(expiry_date)`

## Triggers
- `employees.updated_at` auto-updated on UPDATE.

## Migrations 03 & 04 (added)
- **03_contract.sql** — adds `employees.contract_start_date`, partial index on `contract_end_date`,
  refreshes `v_expiry_alerts`.
- **04_indexes.sql** — `pg_trgm` extension + GIN trigram index on employee name (fast search),
  composite indexes (`branch_id,status` / `team_id,status`), `schedules(shift_code)`,
  `forecasts(branch_id,service_type_id,forecast_date)`, `absences(start_date,end_date)`,
  `disciplinary_actions(archived,action_type)`, `audit_log(username)`.
Run order: 01 → 03 → 04 (then seed). `npm run seed` does this automatically.
