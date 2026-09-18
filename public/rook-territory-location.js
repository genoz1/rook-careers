// A state overlap is a possible territory match, never an exact mile distance.
(function (root) {
  function territories(job) {
    if (job.source_type !== 'custom_html') return [];
    const groups = job.territory_locations || job.extraction_evidence?.territories || [];
    return groups.filter(g => g.scope === 'state_or_region' && Array.isArray(g.states))
      .map(g => ({label:g.label, scope:g.scope, states:g.states}));
  }
  function matchesState(job, stateCode) {
    return !!stateCode && territories(job).some(g => g.states.includes(stateCode));
  }
  // Do not lose territory openings merely because exact-point jobs filled
  // the ranked-result cap before the browser applied its radius filter.
  function retainMatches(rows, limit, stateCode, jobOf = row => row) {
    return rows.filter((row, index) => index < limit || matchesState(jobOf(row), stateCode));
  }
  const api = {territories, matchesState, retainMatches};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RookTerritoryLocation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
