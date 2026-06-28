# Deploying TurniDSP Platform on Render

Render's managed PostgreSQL **requires SSL**. This project enables SSL automatically
whenever `DATABASE_URL` is present (see `server/src/db/pool.js`), so the
"SSL/TLS required" / "Migration failed: SSL/TLS required" error is resolved out of the box.

## Option A — Blueprint (recommended)
1. Push this project to a Git repo.
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml` and creates:
   - a **PostgreSQL** instance (`turnidsp-db`), and
   - a **web service** with Root Directory = `server`.
3. `DATABASE_URL` is wired automatically from the database; `JWT_SECRET` is auto-generated.
4. First deploy runs `npm start` → migrations (SSL on) then serves the API + frontend.

## Option B — Manual
1. **New → PostgreSQL** → create the DB. Copy its **Internal Database URL**.
2. **New → Web Service** → connect the repo.
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
3. Environment variables:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the database's Internal Connection String |
   | `JWT_SECRET` | a long random string |
   | `JWT_TTL` | `12h` (optional) |
   | `PG_POOL_MAX` | `20` (optional) |
   - Do **not** set `PORT` (Render injects it). Do **not** set `PGSSL` — SSL is on by default with `DATABASE_URL`.

## Seed (one time)
The schema is applied automatically on every deploy (idempotent). Seed the reference data
+ admin once via the Render **Shell** for the web service:
```bash
npm run seed
```
This creates the default admin (**admin / admin123**) — change the password immediately.

## SSL behaviour reference
- `DATABASE_URL` present → SSL **on** (`{ rejectUnauthorized: false }`) — Render/Railway/Heroku.
- `PGSSL=true` → force on · `PGSSL=false` → force off (non-TLS DBs only).
- No `DATABASE_URL` (local) → SSL off unless `PGSSL=true`.

## Uploaded files
Render's filesystem is ephemeral. To persist disciplinary/document PDFs, add a **Render Disk**
to the web service and set `UPLOAD_DIR` to its mount path (e.g. `/var/data/uploads`).

---

## Troubleshooting: "cannot log in with admin / admin123"

The admin is auto-created **only when the users table is empty**. If an earlier deploy
already created an `admin` row (or you set `ADMIN_PASSWORD` once), later deploys won't
change its password — so `admin123` may no longer be the password.

**Fix A — env var + redeploy (no Shell needed):**
1. Render → your web service → **Environment** → add `RESET_ADMIN=true`
   (optionally `ADMIN_PASSWORD=<your password>`; omit it to reset to `admin123`).
2. **Manual Deploy / Save** to redeploy. On boot the migration resets the admin password.
3. Log in, then **remove `RESET_ADMIN`** (so it doesn't reset on every deploy).

**Fix B — one-off command (if you have Shell access):**
```bash
npm run reset-admin            # sets admin / admin123
npm run reset-admin MyPass123  # sets admin / MyPass123
```

Check the deploy logs: the migration prints one of
`Admin bootstrap: created/reset login "admin" ...` or
`... user(s) already present; passwords left untouched ...` so you can see what happened.
