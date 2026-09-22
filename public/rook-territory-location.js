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
  // Match is tied to the queried point so an in-flight location change cannot
  // reuse a previous search's territory decision.
  function includesSearchArea(job, point) {
    return !!point && !!job.territory_match &&
      job.territory_match.lat === point.lat && job.territory_match.lng === point.lng;
  }
  function withinRadius(job, point, radius, distance) {
    return includesSearchArea(job, point) ||
      (job.job_lat != null && job.job_lng != null && Number.isFinite(distance) && distance <= radius);
  }
  const api = {territories, matchesState, includesSearchArea, withinRadius};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RookTerritoryLocation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
