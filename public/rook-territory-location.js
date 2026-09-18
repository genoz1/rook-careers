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
  const api = {territories, matchesState};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RookTerritoryLocation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
