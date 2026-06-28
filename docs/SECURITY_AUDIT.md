# Security Audit Report — Gestione Turni DSP Platform
**Date:** Pre-launch  |  **Auditor:** Internal review

---

## PRODUCTION READINESS SCORE: 81 / 100

---

## Requirements Implementation

### 1. HTTPS ONLY ✅
- HTTP → HTTPS 301 redirect in production (reads `x-forwarded-proto` from Render/Railway)
- HSTS: `max-age=31536000; includeSubDomains; preload` (1 year)
- Auth uses JWT in `Authorization` header — not cookies, so no "secure cookie" attribute needed
- **File:** `src/app.js`

### 2. DAILY DATABASE BACKUPS ✅
- `.github/workflows/backup.yml` — runs `pg_dump` daily at 02:00 UTC
- Artifacts retained 30 days in GitHub Actions
- `scripts/backup.sh` — portable script supporting both `DATABASE_URL` and discrete PG* vars
- `scripts/restore.sh` — restore from any `.sql.gz` file
- **Monitoring:** GitHub Actions run history shows pass/fail per day
- **Remaining gap:** no external alert (e.g. PagerDuty) if backup fails; CI email is the signal

### 3. STRONG JWT SECURITY ✅
- Production refuses to start if `JWT_SECRET` < 64 characters
- Access tokens: 30-minute TTL (configurable via `JWT_TTL`)
- Refresh tokens: opaque 48-byte random, stored as SHA-256 hash in `sessions` table
- Token rotation on every refresh — old token immediately revoked
- Reuse detection: if a revoked/unknown token is presented, ALL user sessions are revoked
- Token type claim (`typ: 'access'`) prevents refresh tokens being used as access tokens
- **File:** `src/middleware/auth.js`, `src/routes/auth.js`

### 4. LOGIN RATE LIMITING ✅
- `express-rate-limit`: max 20 requests/IP per 15-minute window → HTTP 429
- DB-backed per-account lockout: 5 failed attempts → locked for 15 min
- Both layers gracefully skip if tables are missing (first deploy, before migration)
- **Config:** `LOGIN_RATE_MAX`, `LOCK_MAX_FAILS`, `LOCK_WINDOW_MIN`

### 5. ROLE-BASED ACCESS CONTROL ✅
Four roles: `admin`, `osm`, `hr_manager`, `team_leader`

| Capability | admin | osm | hr_manager | team_leader |
|---|:---:|:---:|:---:|:---:|
| employee.view | ✅ | ✅ | ✅ | ✅ |
| employee.manage | ✅ | — | ✅ | — |
| schedule.view | ✅ | ✅ | ✅ | ✅ |
| schedule.manage | ✅ | ✅ | — | — |
| forecast.view/manage | ✅ | ✅ | — | view only |
| absence.view | ✅ | ✅ | ✅ | ✅ |
| absence.manage | ✅ | — | ✅ | — |
| disciplinary.view/manage | ✅ | — | ✅ | — |
| document.view/manage | ✅ | view | ✅ | — |
| report.view | ✅ | ✅ | ✅ | — |
| audit.view | ✅ | — | — | — |
| user.manage | ✅ | — | — | — |

Applied at route level via `requirePermission()` middleware on every write endpoint.
- **Files:** `src/middleware/rbac.js`, all route files

### 6. AUDIT LOGS ✅
Every critical action recorded in `audit_log` (user, role, entity, entity_id, action, detail, ip):
- Login / logout / session revoke
- Employee create / update / disable / import
- Schedule modifications (single, bulk, copy)
- Forecast updates
- Absence create / delete
- Disciplinary actions
- Document uploads
- User create / update
- Password reset requests and completions
- **File:** `src/middleware/auth.js` → `audit()`, called from all route handlers

### 7. SESSION MANAGEMENT ✅
- Access token TTL: 30 minutes (idle timeout enforced server-side by expiry)
- Client-side idle detector: 30-minute inactivity → automatic logout + redirect to login
- `GET /api/auth/sessions` — list all active devices
- `DELETE /api/auth/sessions/:id` — revoke specific device
- `POST /api/auth/sessions/revoke-all` — logout everywhere
- Logout revokes the refresh token server-side

### 8. PASSWORD RESET ✅ (infrastructure-dependent)
- Single-use expiring tokens (SHA-256 hashed in DB, 30-min TTL)
- Anti-enumeration: always returns same message regardless of whether account exists
- Complexity rules: ≥10 chars, uppercase, lowercase, digit
- On reset: all existing sessions are revoked
- Email delivery: works when `SMTP_*` vars are set; in non-prod the token is returned in the response for testing
- **File:** `src/routes/password.js`

### 9. DOCUMENT SECURITY ✅
- `/uploads/*` requires valid auth token (401 without it)
- MIME allow-list: PDF, JPEG, PNG only; 10MB limit
- File access controlled by RBAC (`document.view` / `document.manage`)
- ClamAV hook: active when `CLAMAV_HOST` is set; without it files pass type-check only
- **File:** `src/routes/documents.js`, `src/middleware/antivirus.js`

### 10. PRODUCTION READINESS ✅
- All sensitive config via environment variables (no secrets in code)
- DB pool: configurable size, SSL auto-enabled with `DATABASE_URL`
- `unhandledRejection` handler prevents process crashes from stray errors
- Login route: DB error → 503 (not process crash)
- Rate-limit trust-proxy warning suppressed (correctly configured)
- `NODE_ENV=production` enforces all security requirements at startup

---

## Vulnerabilities Fixed

1. **Admin login 503** — `issueRefreshToken` crash on missing `sessions` table; now non-fatal
2. **Insecure default JWT** — now refused in production; minimum 64 chars enforced
3. **No token expiry or refresh** — 30m access tokens + rotating refresh tokens
4. **Token reuse possible** — refresh rotation with reuse detection and full session revoke
5. **No brute-force protection** — IP rate limit + per-account DB-backed lockout
6. **Single role (admin/team_leader)** — four roles with fine-grained capability matrix
7. **Public document uploads** — now require authentication and RBAC permission
8. **No HTTPS enforcement** — 301 redirect + HSTS header
9. **Open CORS** — restricted to `CORS_ORIGIN` allowlist
10. **No password complexity** — rules enforced on reset; admin bootstrap uses `ADMIN_PASSWORD`
11. **Login crashes process on DB error** — wrapped with 503 response + global rejection handler
12. **Admin lockout after redeploy** — bootstrap now re-creates/re-activates admin reliably

---

## Remaining Risks

| Risk | Severity | Mitigation |
|---|---|---|
| JWT in localStorage (XSS risk) | Medium | Strict CSP; no external scripts; consider httpOnly cookies in v2 |
| Virus scanning is a hook only | Medium | Set `CLAMAV_HOST` to activate; without it only MIME/size checked |
| Password reset requires SMTP | Low | Token surfaced in non-prod for testing; configure `SMTP_*` for production |
| Backup has no external alert | Low | Add GitHub Actions → Slack/email webhook on failure |
| CSP allows `unsafe-inline` | Low | Inline scripts/styles required by single-file scheduler; refactor to remove |
| Rate-limit store is in-memory | Low | Use Redis store (`rate-limit-redis`) if running multiple replicas |

---

## Go-Live Checklist

```
[ ] NODE_ENV=production
[ ] JWT_SECRET = 64+ random chars  (node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
[ ] DATABASE_URL set (SSL auto-enabled)
[ ] CORS_ORIGIN = https://your-domain.com
[ ] PUBLIC_URL = https://your-domain.com
[ ] SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM (for password reset emails)
[ ] UPLOAD_DIR = /persistent/volume/path (Render Disk or Railway Volume)
[ ] Add DATABASE_URL secret to GitHub repo for backup workflow
[ ] Log in with admin / admin123 and change the password immediately
[ ] Create OSM, HR Manager, Team Leader accounts
[ ] Remove RESET_ADMIN env var if it was set
```

---

## Score Breakdown (81/100)

| Area | Score | Notes |
|---|---|---|
| Authentication (JWT) | 9/10 | Strong; localStorage residual risk |
| Authorization (RBAC) | 9/10 | Full matrix; route-level enforcement |
| Transport (HTTPS/HSTS) | 9/10 | Complete |
| Brute-force protection | 8/10 | Dual-layer; in-memory store single-replica |
| Audit logging | 8/10 | Comprehensive |
| Session management | 8/10 | Multi-device; idle timeout |
| Password security | 7/10 | Complexity rules; reset needs SMTP |
| Document security | 7/10 | Auth + RBAC; AV is a hook |
| Backup / recovery | 7/10 | Automated; no external alert |
| Code hardening | 9/10 | Crash-safe; no process kill from single request |

**To reach 90+:** activate ClamAV, configure SMTP, add backup alerting, add test suite + `npm audit` CI gate, move to httpOnly cookies with CSRF.
