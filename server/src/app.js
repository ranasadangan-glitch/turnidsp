require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';

// trust proxy so req.ip and req.protocol are correct behind Render/Railway/nginx
app.set('trust proxy', true);

// ---- (1) HTTPS only: redirect HTTP -> HTTPS in production ----
// Render/Railway terminate TLS at the edge and set x-forwarded-proto.
// IMPORTANT: never redirect API calls. A 301 on a POST makes the browser
// replay it as GET (losing the body), which silently breaks login/forms.
// API clients should simply get a clear error instead of a redirect.
app.use((req, res, next) => {
  if (!IS_PROD) return next();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (proto === 'https') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(400).json({ error: 'Richiesta HTTPS richiesta. Usa https://' + req.headers.host + req.originalUrl });
  }
  return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
});

// ---- (1)(4) security headers incl. HSTS ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],   // the app uses onclick=/onchange=/onsubmit= throughout
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // 1 year HSTS
  crossOriginEmbedderPolicy: false,
}));

// ---- restricted CORS (item 1) ----
// The frontend is served by this same Express server, so its own origin must
// always be allowed automatically — no manual CORS_ORIGIN configuration should
// be required for the app to work out of the box. Additional cross-origin
// hosts (e.g. a separately hosted frontend) can still be added via CORS_ORIGIN.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  const corsOptions = { credentials: true };
  if (!origin) { corsOptions.origin = true; return cb(null, corsOptions); }      // same-origin / curl
  if (allowedOrigins.includes(origin)) { corsOptions.origin = true; return cb(null, corsOptions); }
  // Always allow the request's own host (covers Render/Railway/any domain where
  // the frontend and API share the same server) without any manual configuration.
  try {
    if (new URL(origin).host === req.headers.host) { corsOptions.origin = true; return cb(null, corsOptions); }
  } catch { /* malformed Origin header, fall through */ }
  corsOptions.origin = false;
  return cb(null, corsOptions);
}));

app.use(express.json({ limit: '2mb' }));

// ---- API routes ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/password', require('./routes/password').router);
app.use('/api/employees', require('./routes/employees'));
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/forecast', require('./routes/forecast'));
app.use('/api/absences', require('./routes/absences'));
app.use('/api/disciplinary', require('./routes/disciplinary'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/meta', require('./routes/meta'));
app.use('/api/xlsx', require('./routes/xlsx'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/scheduler', require('./routes/scheduler'));
app.use('/api/kpi',           require('./routes/kpi'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/search',        require('./routes/search'));

// uploaded files (PDFs) — honor UPLOAD_DIR (e.g. a Railway/Render volume).
// Protected: these are disciplinary/HR documents, so require a valid token
// (accepted via Authorization header or ?token= for direct links).
const UPLOADS = process.env.UPLOAD_DIR || path.resolve(__dirname, '../uploads');
const { auth } = require('./middleware/auth');
app.use('/uploads', auth, express.static(UPLOADS, { dotfiles: 'deny', index: false }));

// health
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---- serve the frontend ----
// The login page IS the index: '/' serves login.html directly. After
// authentication, app.html (the unified Workspace shell — Dashboard +
// Scheduler merged into one continuous view, plus People/Analytics/
// Settings as sibling sections) is the app's single entry point.
//
// index.html, dashboard.html, scheduler.html, and employees.html are all
// retired: each is now just a tiny redirect shim kept on disk so old
// bookmarks/links land in app.html instead of 404ing. index/dashboard/
// scheduler 301-redirect server-side since they carry no state worth
// preserving. employees.html is deliberately NOT in that list — it's
// still served as a real (tiny) file so its inline script can read
// location.hash (e.g. "#123") and forward the visitor straight to that
// employee's profile inside app.html's People section; a server-side 301
// would happen before any hash could be read and the deep link would be
// lost. New code should never link to any of these four pages directly.
const FRONT = path.resolve(__dirname, '../frontend');

const LEGACY_REDIRECTS = ['/index.html', '/dashboard.html', '/scheduler.html'];
LEGACY_REDIRECTS.forEach((route) => {
  app.get(route, (_req, res) => res.redirect(301, '/app'));
});

app.use(express.static(FRONT, { index: false }));   // don't auto-serve index.html at '/'

app.get('/', (_req, res) => res.sendFile(path.join(FRONT, 'login.html')));
// The application shell — Workspace/People/Analytics/Settings all live here.
app.get('/app', (_req, res) => res.sendFile(path.join(FRONT, 'app.html')));

// fallback: unknown non-API routes go to the login page
app.get('*', (_req, res) => res.sendFile(path.join(FRONT, 'login.html')));

// error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Errore interno' });
});

// Safety net: log unexpected async errors instead of letting the process die.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && reason.message ? reason.message : reason);
});

const PORT = +(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`TurniDSP Platform API on http://localhost:${PORT}`));
