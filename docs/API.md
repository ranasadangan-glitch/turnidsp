# API Reference — TurniDSP Platform

Base URL: `/api`. All endpoints except `POST /auth/login` and `GET /health` require
`Authorization: Bearer <token>`. Team-leader requests are automatically scoped to their
assigned branches/teams; admin sees everything.

## Auth
- `POST /auth/login` → `{ username, password }` → `{ token, user }`
- `GET /auth/me` → `{ user }`

## Employees
- `GET /employees?branch=&team=&status=&q=` → list (scoped)
- `POST /employees` (admin) → create. Body fields: `employee_code, transporter_id,
  first_name, last_name, email, phone, device, branch_id, team_id, service_type_id,
  contract_type_id, weekly_hours, default_shift_code, work_days (int[] ISO 1..7),
  hire_date, contract_end_date, status`
- `PUT /employees/:id` (admin) → update (same fields)
- `PATCH /employees/:id/status` (admin) → `{ status: "active"|"inactive" }` (disable, never delete)
- `POST /employees/import` (admin) → `{ rows: [ {…} ] }` bulk import

## Scheduling
- `GET /schedules?from=&to=&branch=` → `[{employee_id, work_date, shift_code}]`
- `PUT /schedules` → `{ employee_id, work_date, shift_code }` (empty code = delete)
- `POST /schedules/bulk` → `{ items: [{employee_id, work_date, shift_code}] }`
- `POST /schedules/copy` → `{ from_start, to_start, days }` (copy previous week/month)
- `GET /schedules/templates` · `POST /schedules/templates` → `{ name, branch_id, pattern }`

## Teams
- `GET /teams` → with `employee_count`, `leader_name`
- `GET /teams/:id/stats` → counts by status and by service
- `POST /teams` (admin) → `{ branch_id, name, team_leader_id }`
- `PUT /teams/:id` (admin) → `{ name, team_leader_id }`

## Forecast & Dashboard
- `GET /forecast?from=&to=&branch=`
- `PUT /forecast` → `{ branch_id, service_type_id, forecast_date, qty }`
- `GET /forecast/dashboard?from=&to=&branch=` → per service/day:
  `{ forecast, planned, delta }` (coverage % computed client-side)

## Absences
- `GET /absences?employee_id=` · `POST /absences` → `{ employee_id, absence_type, start_date, end_date, note }` · `DELETE /absences/:id`

## Disciplinary
- `GET /disciplinary?employee_id=&archived=&type=`
- `POST /disciplinary` (multipart, optional `document` PDF) → `{ employee_id, action_type, action_date, severity, description }`
- `PATCH /disciplinary/:id/archive` → toggle archive

## Documents & Expiry
- `GET /documents?employee_id=` · `POST /documents` (multipart `file`) → `{ employee_id, doc_type, number, issue_date, expiry_date }`
- `GET /alerts/expiry?days=60` → contract + license + training expiries with `days_left` and `level`

## Reporting
- `GET /reports/summary?from=&to=` → worked/absence/off days, absence rate, contracted hours, per-branch counts
- `GET /reports/forecast-accuracy?from=&to=` → daily forecast vs planned + accuracy %

## Audit (admin)
- `GET /audit?entity=&q=&limit=` → recent audit entries

## Reference / Users
- `GET /meta/branches | service-types | shift-codes | contract-types | parking/:branchId`
- `GET /meta/users` (admin) · `POST /meta/users` (admin) → `{ username, password, full_name, role, branch_ids[], team_ids[] }`
- `PATCH /meta/users/:id` (admin) → `{ active, password, full_name, branch_ids[], team_ids[] }`

---

## Excel Import / Export  (`/api/xlsx`)
- `GET /xlsx/template/:type` — download XLSX template (`employees|forecast|schedule`)
- `POST /xlsx/import/:type` (admin, multipart `file`) — import from XLSX → `{ added, skipped }`
- `GET /xlsx/export/employees` — export employees (scoped)
- `GET /xlsx/export/forecast?from=&to=` — export forecast (scoped)
- `GET /xlsx/export/schedule?from=&to=` — export schedule (scoped)

Download/export endpoints also accept the JWT via `?token=` so the browser can open them directly.

## PDF Reports  (`/api/pdf`)
- `GET /pdf/schedule/weekly?from=&branch=` — weekly schedule grid (landscape)
- `GET /pdf/schedule/monthly?month=YYYY-MM&branch=` — monthly schedule grid
- `GET /pdf/absences?from=&to=&branch=` — absence report
- `GET /pdf/disciplinary?from=&to=&branch=` — disciplinary report
- `GET /pdf/forecast?from=&to=&branch=` — forecast report

## DSP Operations Dashboard
- `GET /reports/dsp-dashboard?date=&branch=` → `{ totals:{forecast,planned,delta,coverage_pct},
  by_service:[…], active_drivers, absent_drivers, open_disciplinary }`

## Pagination & Search (employees)
- `GET /employees?page=&pageSize=&q=&branch=&team=&status=` — when `page`/`pageSize` are present,
  returns `{ rows, total, page, pageSize }`. Search `q` matches name, employee_code, transporter_id
  (backed by a pg_trgm GIN index). Without pagination params the endpoint returns a plain array (back-compat).

## Contract Management
- `employees.contract_start_date` + existing `contract_end_date`; expiry surfaced via
  `GET /alerts/expiry?days=` and the dashboard contract widget.
