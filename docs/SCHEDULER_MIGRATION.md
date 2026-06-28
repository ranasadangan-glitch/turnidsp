# Scheduler Migration Analysis
## localStorage → PostgreSQL

---

## 1. localStorage Audit (full inventory)

Every `localStorage` call in `scheduler.html` catalogued by category:

### A. Schedule data (core — migrated to DB)
| Key | Shape | New location |
|---|---|---|
| `turniDSP_YYYY-MM` | Full state blob `{meta, drivers[], schedule{}, forecast{}, config{}}` | Split into 4 tables (see §3) |
| `turniDSP_config` | `{filiali, codes, services, contracts, autoGen, …}` | `scheduler_config` |

### B. Session/auth state (OK in localStorage — not schedule data)
| Key | Purpose | Status |
|---|---|---|
| `turniDSP_session` | `{role, user, filiale, locked}` | Replaced by platform JWT (`turnidsp_token`) |
| `turniDSP_role` | `"admin"` or `"team"` | Replaced by JWT role claim |
| `turniDSP_teamFil` | Selected branch for team leader | Kept in localStorage (UI preference, non-critical) |
| `turniDSP_pin` | Admin PIN | Replaced by platform auth — not used when DB_SYNC active |
| `turnidsp_token` | Platform access JWT | Correct place (no httpOnly cookie available in this SPA) |
| `turnidsp_user` | Cached user object | Correct place |
| `turnidsp_refresh` | Refresh token | Correct place |
| `turniDSP_api` | Legacy PHP endpoint URL | No longer used with DB_SYNC |

### C. Write-through cache (localStorage as offline cache)
The migration uses **localStorage as a write-through cache**: data is saved to localStorage immediately (for instant UI feedback), then pushed to PostgreSQL asynchronously 1.2 seconds later. This pattern means:
- The scheduler is still usable offline (reads from localStorage cache)
- When online, PostgreSQL is always authoritative
- On `loadMonth()`, the DB snapshot overwrites the local cache

**No `sessionStorage` or `IndexedDB` usage found.**

---

## 2. Data Flow — Before vs After

### Before (localStorage-only)
```
User edits cell
  → state.schedule[driverId][day] = code
  → localStorage.setItem("turniDSP_2026-06", JSON.stringify(state))
  → [data is browser-local, lost on clear, not shared across users/devices]
```

### After (write-through to PostgreSQL)
```
User edits cell
  → state.schedule[driverId][day] = code         [instant, in-memory]
  → localStorage.setItem(lsKey(YM), state)        [local cache for offline]
  → saveState shows "salvato HH:MM ↑DB"
  → setTimeout(saveMonthToDB, 1200ms)             [debounced]
      → POST /api/scheduler/entries/bulk          [writes to PostgreSQL]
          → schedule_entries rows upserted
          → schedule_audit_log row written
```

### Load flow
```
loadMonth() called
  → reads localStorage[lsKey(YM)]   [instant, shows cached data]
  → if (DB_SYNC) loadMonthFromDB(YM, branch)   [async]
      → GET /api/scheduler/month?month=2026-06&branch=DLO1
      → overwrites state from PostgreSQL
      → localStorage.setItem(lsKey(YM), state)   [updates cache]
      → refreshAll()                              [re-renders with DB data]
```

---

## 3. Database Schema — `06_scheduler.sql`

### Table: `schedule_entries`
One row per driver × calendar day. Replaces `state.schedule[id][day]`.

```sql
schedule_entries (
  id              BIGSERIAL PK,
  schedule_month  DATE NOT NULL,        -- stored as YYYY-MM-01
  employee_id     INT → employees(id),  -- NULL if scheduler-only driver
  local_driver_id INT,                  -- scheduler_drivers.id if not in employees
  day_of_month    SMALLINT (1..31),
  shift_code      TEXT NOT NULL,        -- X, SameA, OFF, F, M, …
  branch_code     TEXT,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ,
  UNIQUE (employee_id, schedule_month, day_of_month)   -- partial, WHERE NOT NULL
  UNIQUE (local_driver_id, schedule_month, day_of_month)
)
```
Indexes: `schedule_month`, `employee_id`, `local_driver_id`, `(branch_code, schedule_month)`.

### Table: `scheduler_drivers`
Replaces `state.drivers[]`. Drivers that haven't been "approved" into `employees` yet.

```sql
scheduler_drivers (
  id              SERIAL PK,
  employee_id     INT → employees(id),  -- filled on approve
  cognome, nome   TEXT NOT NULL,
  filiale         TEXT,                 -- branch code
  service, contratto, ctr_type TEXT,
  expiry_date     DATE,
  work_days       INT[],
  default_code    TEXT,
  status          TEXT (active|inactive|pending),
  transporter_id, device, hire_date,
  created_by, created_at, updated_at
)
```

### Table: `schedule_forecasts`
Replaces `state.forecast[service_key][day]`.

```sql
schedule_forecasts (
  id              BIGSERIAL PK,
  schedule_month  DATE NOT NULL,
  branch_code     TEXT NOT NULL,
  service_key     TEXT NOT NULL,   -- SAMEA, NEXT, DLO1_SAMEB, …
  day_of_month    SMALLINT (1..31),
  qty             INT,
  updated_by, updated_at,
  UNIQUE (schedule_month, branch_code, service_key, day_of_month)
)
```

### Table: `scheduler_config`
Replaces `state.config` / `localStorage["turniDSP_config"]`.

```sql
scheduler_config (
  id          SERIAL PK,
  branch_code TEXT NOT NULL,
  config_key  TEXT NOT NULL,   -- 'codes', 'services', 'contracts', 'filiali', …
  config_value JSONB NOT NULL,
  updated_by, updated_at,
  UNIQUE (branch_code, config_key)
)
```

### Table: `schedule_audit_log`
Replaces `state.log[]` (the in-memory action log shown in the Log tab).

```sql
schedule_audit_log (
  id              BIGSERIAL PK,
  schedule_month  DATE,
  branch_code     TEXT,
  actor           TEXT,         -- username
  action          TEXT,         -- "Turno g5: X → OFF"
  driver_id       INT,          -- scheduler_drivers.id
  employee_id     INT,          -- employees.id if resolved
  day_of_month    SMALLINT,
  old_code        TEXT,
  new_code        TEXT,
  logged_at       TIMESTAMPTZ
)
```

---

## 4. API Endpoints — Complete Reference

All under `/api/scheduler`, auth required. Permissions: `schedule.manage` on writes.

### Month snapshot (primary load call)
| Method | Path | Description |
|---|---|---|
| `GET` | `/month?month=YYYY-MM&branch=DLO1` | Full state snapshot: drivers + schedule + forecasts + config. Returns the exact shape the scheduler's `state{}` expects. |
| `POST` | `/month/import` | Import a complete localStorage JSON dump. Body: `{month, branch_code, state}` |

### Schedule entries (grid cells)
| Method | Path | Description |
|---|---|---|
| `GET` | `/entries?month=YYYY-MM&branch=` | All cells for a month |
| `GET` | `/weekly?from=YYYY-MM-DD&branch=` | 7-day window with driver names |
| `GET` | `/monthly?month=YYYY-MM&branch=` | Full month, grouped by driver |
| `PUT` | `/entries` | Upsert single cell `{month, employee_id?, local_driver_id?, day, shift_code, branch_code}` |
| `POST` | `/entries/bulk` | Upsert many cells `{month, branch_code, items:[{…}]}` |
| `DELETE` | `/entries?month=YYYY-MM&branch=` | Reset entire month |

### Drivers
| Method | Path | Description |
|---|---|---|
| `GET` | `/drivers?branch=&status=` | List roster |
| `POST` | `/drivers` | Add driver to scheduler roster |
| `PUT` | `/drivers/:id` | Update driver |
| `POST` | `/drivers/:id/approve` | Promote to `employees` table |
| `POST` | `/drivers/import` | Bulk import from `state.drivers[]` |

### Forecasts
| Method | Path | Description |
|---|---|---|
| `GET` | `/forecasts?month=YYYY-MM&branch=` | Grid for a month |
| `PUT` | `/forecasts` | Upsert one cell |
| `POST` | `/forecasts/bulk` | Upsert many cells |

### Config
| Method | Path | Description |
|---|---|---|
| `GET` | `/config?branch=&key=` | Get config (all keys or one) |
| `PUT` | `/config` | Set one key |
| `POST` | `/config/import` | Import full `state.config` object |

### Audit
| Method | Path | Description |
|---|---|---|
| `GET` | `/log?month=&branch=&limit=` | Scheduler action history |

---

## 5. Scheduler Frontend Changes

### `DB_SYNC` flag (line 579)
```javascript
const DB_SYNC = !!(typeof TurniApi !== 'undefined'
                 && TurniApi.isLoggedIn
                 && TurniApi.isLoggedIn());
```
Automatically `true` when the user is logged into the platform. When `false` (standalone use), the scheduler behaves exactly as before (localStorage only).

### `loadMonth()` — DB-first load
1. Reads localStorage for instant render.
2. If `DB_SYNC`, calls `TurniApi.schedulerMonth(YM, branch)`.
3. If response has `meta.source === "postgresql"`, overwrites `state` from DB.
4. Writes the fresh state back to localStorage (cache refresh).

### `saveAll()` — write-through save
1. Always writes to localStorage immediately.
2. If `DB_SYNC`, debounces `saveMonthToDB()` 1.2s.

### `saveMonthToDB()` — async DB push
Collects all cells and forecasts from `state` and bulk-upserts them:
- `TurniApi.schedulerBulkEntries(YM, branch, items)`
- `TurniApi.schedulerBulkForecasts(YM, branch, items)`
- `TurniApi.schedulerImportDrivers(state.drivers)`

### Auth bridge (lines 1034–1051)
The platform login (`turnidsp_token`) is read from localStorage. If the user is a platform admin, the scheduler opens in admin (editable) mode automatically — no separate PIN required.

---

## 6. Multi-User Support

### How concurrent editing works
- Each cell write is an `UPSERT ON CONFLICT DO UPDATE` — last-write-wins, safe for concurrent saves.
- `updated_by` tracks which user last wrote each cell.
- `schedule_audit_log` records every change with actor, old code, new code.
- Different team leaders on different branches write to different `branch_code` partitions.

### RBAC on schedule data
| Role | GET /month | PUT /entries | DELETE /entries |
|---|---|---|---|
| admin | ✅ all branches | ✅ | ✅ |
| osm | ✅ all branches | ✅ | ✅ |
| hr_manager | ✅ | ❌ 403 | ❌ 403 |
| team_leader | ✅ (UI branch-filtered) | ❌ 403 | ❌ 403 |

---

## 7. Migration Steps for Existing Data

If users already have data in their browser localStorage, import it without losing anything:

### Option A — JSON Export → API Import (per user, per month)
1. In the scheduler, **Dati → Esporta JSON** → downloads `state.json`.
2. Call `POST /api/scheduler/month/import` with body `{month: "YYYY-MM", branch_code: "DLO1", state: <json>}`.
3. All drivers, cells, forecasts, and config are migrated in a transaction.

### Option B — Admin one-off migration script
```javascript
// Run in browser console while logged in to the scheduler
const months = Object.keys(localStorage)
  .filter(k => k.match(/^turniDSP_\d{4}-\d{2}$/))
  .map(k => k.replace('turniDSP_', ''));

for (const m of months) {
  const st = JSON.parse(localStorage.getItem('turniDSP_' + m));
  const branch = st.drivers?.[0]?.filiale || 'DLO1';
  await TurniApi.schedulerImport(m, branch, st);
  console.log('migrated', m, branch);
}
```

### Option C — Automatic on first load
Already implemented: on every `loadMonth()`, if the DB has no data for that month/branch but localStorage does, `saveMonthToDB()` is called after the initial save. This silently migrates data the first time a user opens the scheduler after deployment.

---

## 8. Remaining localStorage Usage (intentional)

After migration, the following localStorage keys are kept intentionally — they are UI preferences, not schedule data:

| Key | Reason kept |
|---|---|
| `turniDSP_YYYY-MM` | Write-through cache for offline use and instant first-paint |
| `turniDSP_config` | Local config cache (also pushed to DB) |
| `turniDSP_teamFil` | Branch UI preference (harmless, non-critical) |
| `turnidsp_token` | Platform JWT (correct location) |
| `turnidsp_refresh` | Refresh token (correct location) |
| `turnidsp_user` | Cached user object (correct location) |

Keys **no longer used** when DB_SYNC is active:
- `turniDSP_session` (replaced by platform JWT)
- `turniDSP_role` (replaced by JWT role claim)
- `turniDSP_pin` (replaced by platform auth)
- `turniDSP_api` (legacy PHP endpoint — not used)

---

## 9. Modified Files Summary

| File | Change |
|---|---|
| `database/schema/06_scheduler.sql` | **NEW** — 5 tables: `schedule_entries`, `scheduler_drivers`, `schedule_forecasts`, `scheduler_config`, `schedule_audit_log` + indexes + trigger |
| `src/routes/scheduler.js` | **NEW** — 18 endpoints covering CRUD, weekly/monthly views, bulk ops, import, audit log |
| `src/app.js` | **MODIFIED** — `app.use('/api/scheduler', require('./routes/scheduler'))` registered |
| `frontend/api.js` | **MODIFIED** — `TurniApi.scheduler*` methods: `schedulerMonth`, `schedulerBulkEntries`, `schedulerBulkForecasts`, `schedulerImportDrivers`, `schedulerWeekly`, `schedulerMonthly`, `schedulerLog`, etc. |
| `frontend/scheduler.html` | **MODIFIED** — `DB_SYNC` flag, `loadMonthFromDB()`, `saveMonthToDB()`, platform auth bridge; localStorage remains as write-through cache |
| `src/db/migrate.js` | **MODIFIED** — `06_scheduler.sql` added to migration sequence |
