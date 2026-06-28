# Deploying TurniDSP Platform on Railway

This project is configured for [Railway](https://railway.app). It includes a root
`package.json` that installs the server and runs database migrations on every deploy,
plus `railway.json`, `nixpacks.toml`, `Procfile`, and `.nvmrc`.

> **Important — Root Directory = `server`.**
> The frontend, database scripts, and Railway config now live *inside* `server/`, so
> the whole deployable app is self-contained. In your Railway service settings set
> **Root Directory = `server`** (Settings → Source). The start command `npm start`
> applies the schema migrations and then serves both the API and the frontend
> (`/` dashboard, `/scheduler.html`). No paths point outside `server/` anymore.

## Architecture on Railway

Two services in one project:
1. **PostgreSQL** — Railway's managed Postgres plugin (provides `DATABASE_URL`).
2. **Web** — this Node/Express app (serves the API and the frontend).

The web service binds to the `PORT` Railway injects, connects to Postgres via
`DATABASE_URL`, and applies the schema automatically on start (idempotent).

---

## Step-by-step

### 1. Create the project & database
- New Project → **Deploy from GitHub repo** (push this folder to a repo first),
  or use the Railway CLI (`railway init`).
- Add a database: **New → Database → PostgreSQL**.

### 2. Add the web service
- **New → GitHub Repo** (the repo containing this project).
- Railway auto-detects Node via the root `package.json` and Nixpacks.
- **Set the service Root Directory to `server`** (Settings → Source → Root Directory).
  Everything needed (frontend, database, config) is inside `server/`.

### 3. Set environment variables (web service → Variables)
| Variable | Value |
|---|---|
| `DATABASE_URL` | Reference the Postgres service: `${{Postgres.DATABASE_URL}}` |
| `PGSSL` | `false` if using Railway's **internal** DB URL (default & recommended); `true` if connecting over the public proxy |
| `JWT_SECRET` | a long random string (e.g. `openssl rand -hex 32`) |
| `JWT_TTL` | `12h` (optional) |
| `PG_POOL_MAX` | `20` (optional) |
| `UPLOAD_DIR` | `/data/uploads` if you attach a Volume (see step 5) |

> `PORT` is provided by Railway automatically — do **not** set it yourself.
> Use the **internal** database reference (`${{Postgres.DATABASE_URL}}`) so traffic
> stays on Railway's private network (faster, no SSL needed).

### 4. Deploy
- Railway builds with Nixpacks, runs `npm install` (which installs `server/`'s deps),
  then `npm start` → applies migrations (`01 → 03 → 04`) and starts the API.
- Health check: `GET /api/health`.

### 5. (Recommended) Persistent storage for uploaded PDFs
Railway's container filesystem is **ephemeral** — files written at runtime are lost on
redeploy. To keep disciplinary/document PDFs:
- Web service → **Volumes → New Volume**, mount path e.g. `/data`.
- Set variable `UPLOAD_DIR=/data/uploads`.
The app creates `/data/uploads/disciplinary` and `/data/uploads/documents` on demand.
(If you skip this, the app still runs; only uploaded files won't persist across deploys.)

### 6. Seed once (first deploy only)
The schema is created automatically, but the initial reference data + admin user are
**not** seeded on every boot (to avoid touching your data). Run the seed one time:

```bash
# with the Railway CLI, against the deployed environment:
railway run npm run seed
```

This inserts branches, service types, shift codes, contract types, and the default
admin (**admin / admin123**). **Log in and change the password immediately.**

### 7. Open the app
Railway gives the web service a public domain (Settings → Networking → Generate Domain).
Visit it, log in, and you're live. The frontend (`/`, dashboard) and the scheduler
(`/scheduler.html`) are served by the same service.

---

## Notes & honest caveats
- **Migrations run on every deploy** but are idempotent (`CREATE/ADD ... IF NOT EXISTS`),
  so they are safe. Seeding is manual (step 6) so it never overwrites live data.
- **SSL**: internal Railway DB URLs don't need SSL (`PGSSL=false`). If you ever connect
  over the public proxy URL, set `PGSSL=true`.
- **Backups**: Railway can back up the Postgres plugin; the included `scripts/backup.sh`
  also works if you run it with the DB credentials (e.g. via `railway run`).
- **Scaling**: the connection pool is capped by `PG_POOL_MAX`; keep it within your
  Postgres plan's connection limit if you run multiple web replicas.

## Railway CLI quick start
```bash
npm i -g @railway/cli
railway login
railway init                 # link/create a project
railway add --database postgres
railway up                   # deploy
railway variables set JWT_SECRET=$(openssl rand -hex 32)
railway run npm run seed     # one-time seed
railway domain               # get a public URL
```
