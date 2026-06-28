// Role-based access control for the four roles:
//   admin        — full system access
//   osm          — forecast, schedules, employee VIEW, reports
//   hr_manager   — employees, contracts, documents, absences
//   team_leader  — view schedules, view employees, daily operations only
//
// Permissions are coarse capability strings checked by requirePermission().

const ROLES = ['admin', 'osm', 'hr_manager', 'team_leader'];

// capability -> roles allowed
const MATRIX = {
  // employees
  'employee.view':        ['admin', 'osm', 'hr_manager', 'team_leader'],
  'employee.manage':      ['admin', 'hr_manager'],
  // contracts & documents (HR)
  'contract.manage':      ['admin', 'hr_manager'],
  'document.view':        ['admin', 'hr_manager', 'osm'],
  'document.manage':      ['admin', 'hr_manager'],
  // absences (HR, with OSM/TL view)
  'absence.view':         ['admin', 'hr_manager', 'osm', 'team_leader'],
  'absence.manage':       ['admin', 'hr_manager'],
  // scheduling
  'schedule.view':        ['admin', 'osm', 'hr_manager', 'team_leader'],
  'schedule.manage':      ['admin', 'osm'],
  // forecast
  'forecast.view':        ['admin', 'osm', 'team_leader'],
  'forecast.manage':      ['admin', 'osm'],
  // disciplinary (HR)
  'disciplinary.view':    ['admin', 'hr_manager'],
  'disciplinary.manage':  ['admin', 'hr_manager'],
  // teams
  'team.view':            ['admin', 'osm', 'hr_manager', 'team_leader'],
  'team.manage':          ['admin'],
  // reports
  'report.view':          ['admin', 'osm', 'hr_manager'],
  // audit & users & config
  'audit.view':           ['admin'],
  'user.manage':          ['admin'],
  'config.manage':        ['admin'],
};

function roleAllowed(permission, role) {
  const allowed = MATRIX[permission];
  return Array.isArray(allowed) && allowed.includes(role);
}

// Express middleware: require one of the given roles.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non autenticato' });
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'Permesso negato per il tuo ruolo' });
  };
}

// Express middleware: require a capability from the matrix.
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non autenticato' });
    if (roleAllowed(permission, req.user.role)) return next();
    return res.status(403).json({ error: 'Permesso negato: ' + permission });
  };
}

module.exports = { ROLES, MATRIX, roleAllowed, requireRole, requirePermission };
