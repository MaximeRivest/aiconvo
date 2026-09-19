/* Explicit browsing scope. Empty string means all projects on this machine;
   the existing loose collection is displayed as "No project". */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectScope = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ALL = '', NONE = 'Loose conversations';
  function normalize(value, folds = {}) {
    if (typeof value !== 'string' || !value || value === '?') return ALL;
    const seen = new Set();
    while (!seen.has(value) && Object.hasOwn(folds, value) && typeof folds[value] === 'string') {
      seen.add(value); value = folds[value];
    }
    return value;
  }
  function contains(scope, project, folds = {}) {
    scope = normalize(scope, folds);
    return !scope || (typeof project === 'string' && !!project && normalize(project, folds) === scope);
  }
  function afterNavigation(scope, project, { select = false, folds = {} } = {}) {
    scope = normalize(scope, folds);
    if (typeof project !== 'string' || !project || project === '?') return scope;
    const target = normalize(project, folds);
    return select || (scope && target !== scope) ? target : scope;
  }
  function label(scope) { return scope === NONE ? 'No project' : scope || 'All projects'; }
  function fileProject(file, projects = [], folds = {}) {
    if (file?.project) return normalize(file.project, folds) || NONE;
    const filePath = String(file?.path || '').replace(/\\/g, '/');
    const matches = projects.filter(p => {
      const cwd = String(p.cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
      return cwd && (filePath === cwd || filePath.startsWith(cwd + '/'));
    }).sort((a, b) => b.cwd.length - a.cwd.length);
    return matches.length ? normalize(matches[0].name, folds) : NONE;
  }
  return { ALL, NONE, normalize, contains, afterNavigation, label, fileProject };
});
