// A state overlap is a possible territory match, never an exact mile distance.
(function (root) {
  function territories(job) {
    const groups = job.territory_locations || job.extraction_evidence?.territories || [];
    const structured = groups.filter(g => g.scope === 'state_or_region' && Array.isArray(g.states))
      .map(g => ({label:g.label, scope:g.scope, states:g.states}));
    const scope = job.location_evidence?.scope;
    if (scope?.kind === 'territory' && Array.isArray(scope.states) && scope.states.length) {
      structured.push({label:job.location_raw || 'Assigned territory', scope:'state_or_region', states:scope.states});
    }
    return structured;
  }
  function matchesState(job, stateCode) {
    return !!stateCode && territories(job).some(g => g.states.includes(stateCode));
  }
  const api = {territories, matchesState};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RookTerritoryLocation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
