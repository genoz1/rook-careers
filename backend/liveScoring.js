// Canonical live-dashboard scoring options. Every authenticated /jobs path
// (home, explore, recruiter) must use these so ranking stays aligned with
// V7 matching — smooth local distance, geographic eligibility from prepareJob,
// and canonical veterinary industry evidence.
const { scoreJob } = require('./matching');
const { prepareJob } = require('./v7Location');

function liveScoreOptions(prepared) {
  return {
    geography: prepared?.geographic_eligibility || null,
    smoothLocalDistance: true,
    canonicalVeterinaryEvidence: true,
  };
}

function scoreLiveJob(job, profile, prepared = null) {
  const ready = prepared || (job?.geographic_eligibility ? job : prepareJob(job, profile));
  if (!ready) return null;
  return scoreJob(ready, profile, liveScoreOptions(ready));
}

module.exports = { liveScoreOptions, scoreLiveJob };
