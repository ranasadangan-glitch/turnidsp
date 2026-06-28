# Security & Pre-Launch Checklist — TurniDSP Platform

All six hardening items are implemented. Configure the environment variables below before going live.

## 1. Restricted CORS
`app.js` allows same-origin always; cross-origin only for hosts listed in `CORS_ORIGIN`
(comma-separated). Leave `CORS_ORIGIN` empty for a single-domain deployment.
```
CORS_ORIGIN=https://app.tuodominio.it,https://admin.tuodominio.it
```

## 2. JWT secret enforcement
In production (`NODE_ENV=production`) the app **refuses to start** if `JWT_SECRET`
is missing, the default, or shorter than 16 chars.
```
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 32)
```

## 3. Login rate limiting
`POST /api/auth/login` is capped per IP (default 10 / 15 min) via `express-rate-limit`.
Exceeding it returns HTTP 429.
```
LOGIN_RATE_MAX=10
```

## 4. Helmet security headers
`helmet` sets CSP, HSTS, X-Frame-Options (SAMEORIGIN), X-Content-Type-Options (nosniff),
and more. The CSP permits the inline styles/scripts the single-file frontend uses.

## 5. Protected document uploads
`/uploads/*` (disciplinary & HR PDFs) now requires a valid token (Authorization header
or `?token=` for direct links). Unauthenticated requests get 401.

## 6. Automated backups
- `scripts/backup.sh` / `scripts/restore.sh` support both `DATABASE_URL` and local PG* vars.
- **Scheduled CI backups:** `.github/workflows/backup.yml` runs `pg_dump` daily and stores
  the dump as a workflow artifact (set repo secret `DATABASE_URL`).
- Render and Railway also offer managed database backups in their dashboards.

## Additional resilience (added)
- The login route returns 503 on a database error instead of crashing.
- A global `unhandledRejection` handler logs stray async errors so one failure can't take
  the whole service down.
- **Recommendation:** the other route handlers call the DB without per-route try/catch.
  They're fine when the DB is healthy, but for maximum robustness wrap them similarly or
  add an async error-forwarding wrapper. Not required for launch, but advised.

## Required production env summary
```
NODE_ENV=production
JWT_SECRET=<32+ random chars>
DATABASE_URL=<managed connection string>     # SSL auto-enabled
CORS_ORIGIN=<your domain(s)>                  # optional; empty = same-origin only
LOGIN_RATE_MAX=10                             # optional
UPLOAD_DIR=/var/data/uploads                  # optional; persistent volume for PDFs
ADMIN_PASSWORD=<strong>                        # optional; initial admin password
```
