/* TurniDSP Platform — lightweight API client.
   Stores the JWT in memory + localStorage, attaches it to every request,
   and exposes typed helpers for each module. Used by the dashboard and
   can be wired into the existing scheduler.html. */
(function (global) {
  const API = (localStorage.getItem('turnidsp_api_base') || '') + '/api';
  let token = localStorage.getItem('turnidsp_token') || null;
  let refresh = localStorage.getItem('turnidsp_refresh') || null;

  async function doFetch(method, path, body, isForm) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (isForm) { payload = body; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    return fetch(API + path, { method, headers, body: payload });
  }

  async function tryRefresh() {
    if (!refresh) return false;
    try {
      const res = await fetch(API + '/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
      });
      if (!res.ok) return false;
      const d = await res.json();
      setToken(d.token); setRefresh(d.refresh);
      if (d.user) localStorage.setItem('turnidsp_user', JSON.stringify(d.user));
      return true;
    } catch { return false; }
  }

  async function req(method, path, body, isForm) {
    let res = await doFetch(method, path, body, isForm);
    if (res.status === 401) {
      const data = await res.clone().json().catch(() => ({}));
      // Login 401 (or no token) = bad credentials, surface real message.
      if (path.startsWith('/auth/login') || (!token && !refresh)) {
        throw new Error(data.error || 'Credenziali non valide');
      }
      // Access token expired (session idle/short TTL) → try a one-time refresh.
      if (path !== '/auth/refresh' && await tryRefresh()) {
        res = await doFetch(method, path, body, isForm);
      } else {
        logout();
        throw new Error('Sessione scaduta');
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('Errore ' + res.status));
    return data;
  }
  function setToken(t) { token = t; if (t) localStorage.setItem('turnidsp_token', t); else localStorage.removeItem('turnidsp_token'); }
  function setRefresh(t) { refresh = t; if (t) localStorage.setItem('turnidsp_refresh', t); else localStorage.removeItem('turnidsp_refresh'); }
  function logout() { setToken(null); setRefresh(null); localStorage.removeItem('turnidsp_user'); }

  const Api = {
    base: API,
    isLoggedIn: () => !!token,
    user: () => { try { return JSON.parse(localStorage.getItem('turnidsp_user')); } catch { return null; } },
    setApiBase: (url) => localStorage.setItem('turnidsp_api_base', url || ''),

    async login(username, password) {
      const r = await req('POST', '/auth/login', { username, password });
      if (r.refresh) setRefresh(r.refresh);
      setToken(r.token); localStorage.setItem('turnidsp_user', JSON.stringify(r.user));
      return r.user;
    },
    async logout() {
      try { if (refresh) await fetch(API + '/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ refresh }) }); } catch {}
      logout();
    },
    // (7) idle auto-logout: calls onTimeout after `minutes` of no activity.
    startIdleTimeout(minutes, onTimeout) {
      const ms = (minutes || 30) * 60000;
      let t;
      const reset = () => { clearTimeout(t); t = setTimeout(() => { logout(); onTimeout && onTimeout(); }, ms); };
      ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach((e) => window.addEventListener(e, reset, { passive: true }));
      reset();
    },
    sessions: () => req('GET', '/auth/sessions'),
    revokeSession: (id) => req('DELETE', '/auth/sessions/' + id),
    revokeAllSessions: () => req('POST', '/auth/sessions/revoke-all'),
    forgotPassword: (username) => req('POST', '/password/forgot', { username }),
    resetPassword: (tokenStr, password) => req('POST', '/password/reset', { token: tokenStr, password }),

    // meta
    branches: () => req('GET', '/meta/branches'),
    serviceTypes: () => req('GET', '/meta/service-types'),
    shiftCodes: () => req('GET', '/meta/shift-codes'),
    contractTypes: () => req('GET', '/meta/contract-types'),
    users: () => req('GET', '/meta/users'),
    createUser: (u) => req('POST', '/meta/users', u),
    updateUser: (id, u) => req('PATCH', '/meta/users/' + id, u),
    branchesMeta: () => req('GET', '/meta/branches'),

    // employees
    employees: (q = {}) => req('GET', '/employees?' + new URLSearchParams(q)),
    createEmployee: (e) => req('POST', '/employees', e),
    updateEmployee: (id, e) => req('PUT', '/employees/' + id, e),
    setEmployeeStatus: (id, status) => req('PATCH', '/employees/' + id + '/status', { status }),
    importEmployees: (rows) => req('POST', '/employees/import', { rows }),

    // ---- Scheduler (PostgreSQL-backed: replaces localStorage) ----
    // Full month snapshot — replaces localStorage.getItem('turniDSP_YYYY-MM')
    schedulerMonth: (month, branch) => req('GET', '/scheduler/month?' + new URLSearchParams({ month, ...(branch ? { branch } : {}) })),
    // Import a raw state{} object from the old localStorage export
    schedulerImport: (month, branch_code, state) => req('POST', '/scheduler/month/import', { month, branch_code, state }),
    // Entries (cells)
    schedulerEntries: (month, branch) => req('GET', '/scheduler/entries?' + new URLSearchParams({ month, ...(branch ? { branch } : {}) })),
    schedulerSetEntry: (body) => req('PUT', '/scheduler/entries', body),
    schedulerBulkEntries: (month, branch_code, items) => req('POST', '/scheduler/entries/bulk', { month, branch_code, items }),
    schedulerDeleteEntries: (month, branch) => req('DELETE', '/scheduler/entries?' + new URLSearchParams({ month, ...(branch ? { branch } : {}) })),
    // Weekly / monthly views
    schedulerWeekly: (from, branch) => req('GET', '/scheduler/weekly?' + new URLSearchParams({ from, ...(branch ? { branch } : {}) })),
    schedulerMonthly: (month, branch) => req('GET', '/scheduler/monthly?' + new URLSearchParams({ month, ...(branch ? { branch } : {}) })),
    // Drivers (local scheduler roster)
    schedulerDrivers: (branch, status) => req('GET', '/scheduler/drivers?' + new URLSearchParams({ ...(branch ? { branch } : {}), ...(status ? { status } : {}) })),
    schedulerCreateDriver: (d) => req('POST', '/scheduler/drivers', d),
    schedulerUpdateDriver: (id, d) => req('PUT', '/scheduler/drivers/' + id, d),
    schedulerApproveDriver: (id) => req('POST', '/scheduler/drivers/' + id + '/approve'),
    schedulerImportDrivers: (drivers) => req('POST', '/scheduler/drivers/import', { drivers }),
    // Forecasts
    schedulerForecasts: (month, branch) => req('GET', '/scheduler/forecasts?' + new URLSearchParams({ month, ...(branch ? { branch } : {}) })),
    schedulerSetForecast: (body) => req('PUT', '/scheduler/forecasts', body),
    schedulerBulkForecasts: (month, branch_code, items) => req('POST', '/scheduler/forecasts/bulk', { month, branch_code, items }),
    // Config (shift codes, services, contracts…)
    schedulerConfig: (branch, key) => req('GET', '/scheduler/config?' + new URLSearchParams({ branch: branch || 'DLO1', ...(key ? { key } : {}) })),
    schedulerSetConfig: (branch_code, key, value) => req('PUT', '/scheduler/config', { branch_code, key, value }),
    schedulerImportConfig: (branch_code, config) => req('POST', '/scheduler/config/import', { branch_code, config }),
    // Audit log
    schedulerLog: (month, branch, limit) => req('GET', '/scheduler/log?' + new URLSearchParams({ ...(month ? { month } : {}), ...(branch ? { branch } : {}), ...(limit ? { limit } : {}) })),
    setShift: (employee_id, work_date, shift_code) => req('PUT', '/schedules', { employee_id, work_date, shift_code }),
    bulkShifts: (items) => req('POST', '/schedules/bulk', { items }),
    copyShifts: (from_start, to_start, days) => req('POST', '/schedules/copy', { from_start, to_start, days }),
    templates: () => req('GET', '/schedules/templates'),
    createTemplate: (t) => req('POST', '/schedules/templates', t),

    // teams
    teams: () => req('GET', '/teams'),
    teamStats: (id) => req('GET', '/teams/' + id + '/stats'),
    createTeam: (t) => req('POST', '/teams', t),
    updateTeam: (id, t) => req('PUT', '/teams/' + id, t),

    // forecast / dashboard
    forecast: (from, to, branch) => req('GET', '/forecast?' + new URLSearchParams({ from, to, ...(branch ? { branch } : {}) })),
    setForecast: (f) => req('PUT', '/forecast', f),
    dashboard: (from, to, branch) => req('GET', '/forecast/dashboard?' + new URLSearchParams({ from, to, ...(branch ? { branch } : {}) })),

    // absences / disciplinary / documents / alerts
    absences: (q = {}) => req('GET', '/absences?' + new URLSearchParams(q)),
    createAbsence: (a) => req('POST', '/absences', a),
    disciplinary: (q = {}) => req('GET', '/disciplinary?' + new URLSearchParams(q)),
    createDisciplinary: (form) => req('POST', '/disciplinary', form, true),
    archiveDisciplinary: (id) => req('PATCH', '/disciplinary/' + id + '/archive'),
    documents: (employee_id) => req('GET', '/documents?' + new URLSearchParams({ employee_id })),
    uploadDocument: (form) => req('POST', '/documents', form, true),
    expiryAlerts: (days = 60) => req('GET', '/alerts/expiry?days=' + days),

    // reports / audit
    kpi: (q = {}) => req('GET', '/kpi?' + new URLSearchParams(q)),
    // notifications
    notifications: (q = {}) => req('GET', '/notifications?' + new URLSearchParams(q)),
    markRead: (id) => req('PATCH', '/notifications/' + id + '/read'),
    markAllRead: () => req('PATCH', '/notifications/read-all'),
    dismissNotification: (id) => req('DELETE', '/notifications/' + id + '/dismiss'),
    refreshNotifications: () => req('POST', '/notifications/refresh'),
    // global search
    search: (q, limit) => req('GET', '/search?' + new URLSearchParams({ q, ...(limit ? { limit } : {}) })),
    // employee profile
    employeeProfile: (id) => req('GET', '/employees/' + id),
    reportSummary: (from, to) => req('GET', '/reports/summary?' + new URLSearchParams({ from, to })),
    forecastAccuracy: (from, to) => req('GET', '/reports/forecast-accuracy?' + new URLSearchParams({ from, to })),
    dspDashboard: (date, branch) => req('GET', '/reports/dsp-dashboard?' + new URLSearchParams({ ...(date ? { date } : {}), ...(branch ? { branch } : {}) })),
    audit: (q = {}) => req('GET', '/audit?' + new URLSearchParams(q)),

    // Excel + PDF: build a URL the browser can open/download with the token.
    fileUrl: (path) => API + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token || ''),
    xlsxTemplateUrl: (type) => Api.fileUrl('/xlsx/template/' + type),
    xlsxExportUrl: (type, q = {}) => Api.fileUrl('/xlsx/export/' + type + '?' + new URLSearchParams(q)),
    pdfUrl: (path, q = {}) => Api.fileUrl('/pdf/' + path + '?' + new URLSearchParams(q)),
    xlsxImport: (type, file) => { const fd = new FormData(); fd.append('file', file); return req('POST', '/xlsx/import/' + type, fd, true); },
  };

  global.TurniApi = Api;
})(window);
