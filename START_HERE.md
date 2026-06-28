# Gestione Turni — START HERE

A fresh, verified build of the workforce-management platform
(Node + Express + PostgreSQL, with the scheduler, Excel/PDF, dashboard, and security hardening).

The site opens on the **login page**. After login you reach the dashboard; the scheduler
is at `/scheduler.html` and now follows the platform login automatically.

## Deploy on Render (fastest path)

1. Push this project to a Git repo (GitHub/GitLab).
2. Render → **New → Blueprint** and pick the repo. `render.yaml` creates:
   - a PostgreSQL database, and
   - the web service (**Root Directory = `server`**), with `DATABASE_URL` wired in and
     `JWT_SECRET` auto-generated.
3. First deploy runs the migrations and **auto-creates the admin** when the database is empty.
4. Open the service URL and log in:

   **admin / admin123**  → change the password after first login.

### If you can't log in with admin / admin123
This happens when the database already had an admin from a previous attempt. Fix it without a shell:
- Render → web service → **Environment** → add `RESET_ADMIN=true`
  (optionally `ADMIN_PASSWORD=<your password>`), then **Manual Deploy**.
- Log in, then remove `RESET_ADMIN`.
(Full details in `docs/RENDER.md`.)

## Run locally
```bash
createdb turnidsp
cd server
cp .env.example .env          # set JWT_SECRET; DATABASE_URL optional for local
npm install
npm run seed                  # schema + reference data + admin
npm start                     # http://localhost:3000
```

## What's inside
- `server/src` — Express API (auth, employees, schedules, teams, forecast, absences,
  disciplinary, documents, alerts, reports, audit, meta, xlsx, pdf).
- `server/frontend` — `login.html` (landing), `index.html` (dashboard), `scheduler.html`.
- `server/database` — PostgreSQL schema, indexes, seed.
- `docs/` — API, DATABASE, RENDER, RAILWAY, SECURITY.
- Security: restricted CORS, JWT-secret enforcement, login rate limiting, Helmet headers,
  protected uploads, automated backups (`scripts/` + `.github/workflows/backup.yml`).

## Honest notes
- The **scheduler** stores its data in the browser (localStorage); it is not yet wired to
  the platform database. It opens in admin (editable) mode automatically after you log in.
- The dashboard's data-entry screens cover users/team accounts, Excel import/export, and PDF
  reports; some module CRUD screens are still API-first (endpoints exist, rich UI can be added).
