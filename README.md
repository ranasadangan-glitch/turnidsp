# TurniDSP — Workforce Management Platform

A workforce management platform for an Amazon DSP operation, built on top of the
existing TurniDSP scheduler. It replaces JSON/localStorage with **PostgreSQL** and
adds a **Node.js + Express** API with JWT authentication, role-based access (Admin /
Team Leader), an audit trail, and automatic database backups.

The existing single-file scheduler is preserved (`frontend/scheduler.html`) and the
platform adds a professional dashboard (`frontend/index.html`) plus REST APIs for every module.

> **Scope note (read me):** this package is a complete, working **full-stack scaffold** —
> real schema, real APIs, real auth/audit/backups, and a dashboard wired to the API.
> The data-entry UIs for some modules (employees, teams, disciplinary) currently expose
> their data via the API and the dashboard reads several of them; building rich CRUD
> screens for each is the natural next step. Every endpoint exists and is documented below.

---

## 1. Requirements

- **Node.js 18+**
- **PostgreSQL 14+**
- A reverse proxy (nginx/Apache) is recommended for production.

## 2. Project layout

```
TurniDSP-Platform/
├─ server/                 Node + Express API
│  ├─ src/
│  │  ├─ app.js            entry point (serves API + frontend)
│  │  ├─ db/pool.js        PostgreSQL pool + transaction helper
│  │  ├─ db/migrate.js     schema/seed runner
│  │  ├─ middleware/auth.js  JWT, RBAC scope, audit()
│  │  └─ routes/           auth, employees, schedules, teams, forecast,
│  │                        absences, disciplinary, documents, alerts,
│  │                        reports, audit, meta
│  ├─ scripts/hash.js      bcrypt hash generator
│  ├─ uploads/             stored PDFs (disciplinary, documents)
│  └─ .env.example
├─ database/
│  ├─ schema/01_schema.sql full PostgreSQL schema
│  ├─ seeds/02_seed.sql    branches, services, codes, admin user
│  └─ run_all.sql          schema + seed combined
├─ frontend/
│  ├─ index.html           professional dashboard (login, KPIs, alerts…)
│  ├─ api.js               API client used by the dashboard
│  └─ scheduler.html       the existing scheduler app (preserved)
├─ scripts/
│  ├─ backup.sh            automatic pg_dump backup (cron)
│  └─ restore.sh           restore from a backup
└─ docs/
   ├─ API.md               full endpoint reference
   └─ DATABASE.md          schema reference
```

## 3. Install & run (development)

```bash
# 1) Create the database
createdb turnidsp
createuser turnidsp --pwprompt          # set a password
psql -d turnidsp -c "GRANT ALL ON SCHEMA public TO turnidsp;"

# 2) Configure the server
cd server
cp .env.example .env                     # edit credentials + JWT_SECRET
npm install

# 3) Create the schema and seed data
npm run seed                             # runs database/run_all logic via migrate.js --seed
#    (or:  psql -d turnidsp -f ../database/run_all.sql )

# 4) Start the API + frontend
npm start
# -> http://localhost:3000
```

Open `http://localhost:3000`, log in with **admin / admin123**, and change the password
immediately (Users module / `PATCH /api/meta/users/:id`).

## 4. Production notes

- Put the API behind nginx with HTTPS. Example proxy:
  ```
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-For $remote_addr; }
  ```
- Run the Node process with a manager (pm2 / systemd).
- Set a strong `JWT_SECRET` in `.env`.
- The frontend talks to the same origin by default; to host the frontend separately,
  set the API base in the login screen ("API server").

## 5. Automatic backups

`scripts/backup.sh` runs `pg_dump` (gzipped) plus a tar of uploaded PDFs, with retention.
Schedule it with cron:

```cron
# every night at 02:00, keep 30 days
0 2 * * * PGDATABASE=turnidsp BACKUP_DIR=/var/backups/turnidsp KEEP_DAYS=30 /path/TurniDSP-Platform/scripts/backup.sh >> /var/log/turnidsp-backup.log 2>&1
```

Restore with `scripts/restore.sh /var/backups/turnidsp/turnidsp_YYYYmmdd_HHMMSS.sql.gz`.

## 6. Security model

- **Admin**: full access to all branches, teams, configuration, users, and the audit log.
- **Team Leader**: access scoped to their assigned branches/teams only (enforced server-side
  in every query via `loadScope` + `scopeWhere`). They cannot see or edit other branches' data.
- **Audit trail**: every mutating endpoint records `username, role, entity, action, detail, ip`
  in `audit_log` (login/logout, schedule/employee/absence/disciplinary/user/config changes).
- Passwords are stored as **bcrypt** hashes; sessions use **JWT** (12h default TTL).

## 7. Capacity

The schema and queries are indexed for the target scale (500+ employees, 40+ team leaders,
5–7 branches). `schedules` and `forecasts` are indexed by date and entity; the connection
pool is configurable (`PG_POOL_MAX`).

## 8. Module → endpoint map

| Module | Endpoints |
|---|---|
| Employee Management | `GET/POST/PUT /api/employees`, `PATCH /api/employees/:id/status`, `POST /api/employees/import` |
| Advanced Scheduling | `GET/PUT /api/schedules`, `POST /api/schedules/bulk`, `POST /api/schedules/copy`, `/templates` |
| Team Management | `GET/POST/PUT /api/teams`, `GET /api/teams/:id/stats` |
| Forecast vs Planned | `GET/PUT /api/forecast`, `GET /api/forecast/dashboard` |
| Absences | `GET/POST/DELETE /api/absences` |
| Disciplinary | `GET/POST /api/disciplinary` (PDF upload), `PATCH /api/disciplinary/:id/archive` |
| Documents & Expiry | `GET/POST /api/documents`, `GET /api/alerts/expiry` |
| Reporting & Analytics | `GET /api/reports/summary`, `GET /api/reports/forecast-accuracy` |
| Audit Log | `GET /api/audit` (admin) |
| Reference / Users | `GET /api/meta/*`, `GET/POST/PATCH /api/meta/users` |

See `docs/API.md` for full request/response details.


---

## What's new in this update (production features)

1. **Excel Import/Export** (`/api/xlsx`) — import employees, forecast and schedules from XLSX,
   export the same, and download ready templates. Imports are admin-only; exports are branch-scoped.
2. **DSP Operations Dashboard** (`/api/reports/dsp-dashboard`) — forecast, planned, delta, coverage %,
   active drivers, absent drivers, and open disciplinary cases in one snapshot (shown on the dashboard).
3. **Contract Management** — `contract_start_date` added alongside `contract_end_date`; expiry alerts
   and a dashboard widget (60-day look-ahead, colour-coded).
4. **Team Leader Permissions** — enforced server-side on every endpoint via `loadScope` + branch/team
   filters; team leaders only see and manage their assigned branches/teams, admin sees everything.
5. **PDF Reporting** (`/api/pdf`) — weekly & monthly schedule PDFs, absence, disciplinary and forecast reports.
6. **Performance** — pagination on the employee list, pg_trgm trigram search, and additional indexes
   (migrations 03 & 04) sized for 500+ employees and 40+ team leaders.

No existing tables, routes, or files were removed — all additions are backward compatible.
The migration order is now `01 → 03 → 04` (+ seed), handled automatically by `npm run seed`.


---

## Railway deployment

This project ships ready for Railway. Root-level config files: `package.json`
(delegates install/start into `server/`), `railway.json`, `nixpacks.toml`, `Procfile`,
`.nvmrc`. The DB pool reads Railway's `DATABASE_URL`; the app uses Railway's `PORT`;
the schema is auto-applied on deploy. Full instructions: **`docs/RAILWAY.md`**.

Quick version: create a Postgres plugin + this web service, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`
and a strong `JWT_SECRET`, deploy, then run `railway run npm run seed` once. Attach a Volume
and set `UPLOAD_DIR=/data/uploads` to persist uploaded PDFs.


---

## Deployment layout (Railway, Root Directory = server)

To deploy on Railway with **Root Directory = `server`**, the project is fully
self-contained under `server/`:

```
server/
├─ src/            API (app.js serves API + frontend)
├─ frontend/       index.html (dashboard), scheduler.html, api.js
├─ database/       schema + seeds (migrations run on start)
├─ scripts/        hash.js
├─ railway.json, nixpacks.toml, Procfile, .nvmrc
└─ package.json    "start" = migrate + serve
```

`npm start` (Railway's command) runs the migrations then serves both the API and the
static frontend. `/` → dashboard, `/scheduler.html` → scheduler. See `docs/RAILWAY.md`.
