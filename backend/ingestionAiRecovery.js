const { diagnoseIngestion } = require('./ai/ingestionDiagnosis');
const { boundedEmployer } = require('./ingestDeadline');
async function executeDecision(decision, employer, entry, worker = boundedEmployer) {
  if (!['retry_verified_source', 'sync_without_optional_enrichment', 'escalate'].includes(decision.action)) throw Error('Recovery action is not allow-listed');
  if (decision.action === 'escalate') return { resolved: false, action: 'escalate' };
  if (employer.ingestion_hold_reason) return { resolved: false, reason: employer.ingestion_hold_reason };
  if (!employer.active || !employer.id || !employer.ats_type || !employer.ats_identifier) return { resolved: false, reason: 'Verified active source configuration unavailable' };
  // A model cannot authorize a retry after a parser/authentication/identity
  // error, or enable a write on the basis of its own confidence.
  const transient = /timeout|timed out|429|502|503|504|ECONNRESET|fetch failed|network/i.test(entry.error || '') ||
    entry.status === 'timeout' || Number(entry.metrics?.embedding_failures) > 0;
  if (!transient) return { resolved: false, reason: 'No locally verifiable transient failure eligible for retry' };
  const result = await worker(employer, 60000, { repairSourceOnly: decision.action === 'sync_without_optional_enrichment', disableClosures: true });
  const resolved = result.status === 'completed' && result.counts_complete !== false &&
    !result.metrics?.write_failures && !result.metrics?.source_failures && !result.metrics?.partial_snapshots && !result.metrics?.embedding_failures;
  return { resolved, action: decision.action, verification: result };
}
function createAiRecovery(db, { diagnose = diagnoseIngestion, worker = boundedEmployer, maxDiagnoses = 2 } = {}) {
  let used = 0;
  return async function repair(incident, entry) {
    if (incident.ai_result) return incident.ai_result;
    if (incident.ai_attempted_at) return { resolved: false, reason: 'Previous recovery did not record verified completion' };
    if (used >= maxDiagnoses) return { pending: true };
    const owner = 'ai-recovery:' + incident.incident_id;
    const staleBefore = new Date(Date.now() - 35 * 60000).toISOString();
    const { data: lease, error: leaseError } = await db.from('ingestion_run_lock')
      .update({ locked_at: new Date().toISOString(), locked_by: owner }).eq('id', 1)
      .or(`locked_at.is.null,locked_at.lt.${staleBefore}`).select('id');
    if (leaseError) return { resolved: false, reason: 'Safe ingestion overlap lock unavailable' };
    if (!lease?.length) return { pending: true };
    try {
    const { data: claimed, error: claimError } = await db.from('ingestion_incidents')
      .update({ ai_attempted_at: new Date().toISOString() }).eq('employer_id', incident.employer_id)
      .eq('incident_id', incident.incident_id).is('ai_attempted_at', null).select('employer_id');
    if (claimError) throw Error('Cannot record AI recovery claim: ' + claimError.message);
    if (!claimed?.length) return { pending: true };
    used++;
    let decision = null, result;
    try {
      const { data: employer, error } = await db.from('employers').select('*').eq('id', incident.employer_id).single();
      if (error) throw Error('Cannot load verified employer configuration');
      decision = await diagnose(employer, entry);
      // Save the decision before any action. Failure to save means no action.
      const { error: decisionError } = await db.from('ingestion_incidents').update({ ai_diagnosis: decision }).eq('employer_id', incident.employer_id).eq('incident_id', incident.incident_id);
      if (decisionError) throw Error('Cannot record AI diagnosis');
      result = await executeDecision(decision, employer, entry, worker);
    } catch (error) { result = { resolved: false, reason: error.message }; }
    const { error } = await db.from('ingestion_incidents').update({ ai_result: result }).eq('employer_id', incident.employer_id).eq('incident_id', incident.incident_id);
    if (error) throw Error('Cannot record verified recovery result');
    return result;
    } finally {
      const { error } = await db.from('ingestion_run_lock').update({ locked_at: null, locked_by: null }).eq('id', 1).eq('locked_by', owner);
      if (error) console.error('[ingestion-recovery] Lock release failed:', error.message);
    }
  };
}
module.exports = { executeDecision, createAiRecovery };
