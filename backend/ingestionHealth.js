// Durable incident tracking, scoped to ingestion. Healthy runs and automatic
// recoveries stay quiet. Two failed scheduled observations trigger one email;
// successful recovery closes the incident so a later recurrence can alert.
const { randomUUID } = require('node:crypto');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function nextIncident(previous, entry, runId, now) {
  if (previous?.last_run_id === runId) return previous;
  if (entry.status === 'not_reached' || entry.status === 'running') return null;
  const healthy = entry.status === 'completed' && entry.counts_complete !== false &&
    !entry.metrics?.write_failures && !entry.metrics?.source_failures && !entry.metrics?.embedding_failures && !entry.metrics?.partial_snapshots;
  if (healthy && !previous) return null;
  const reopened = !previous || previous.resolved_at;
  return {
    employer_id: entry.employer_id,
    incident_id: reopened ? randomUUID() : previous.incident_id,
    first_seen_at: reopened ? now : previous.first_seen_at,
    last_seen_at: now, last_run_id: runId,
    consecutive_failures: healthy ? 0 : (reopened ? 1 : previous.consecutive_failures + 1),
    resolved_at: healthy ? now : null,
    emailed_at: reopened ? null : previous.emailed_at,
    ai_attempted_at: reopened ? null : previous.ai_attempted_at,
    ai_diagnosis: reopened ? null : previous.ai_diagnosis,
    ai_result: reopened ? null : previous.ai_result,
    details: { name: entry.name, status: entry.status, error: entry.error || null,
      warnings: entry.warnings || [], attempts: entry.attempts?.length || 1,
      counts_complete: entry.counts_complete !== false },
  };
}
async function checkIngestionHealth(db, run, { sendEmail = require('./email/resend').sendEmail,
  to = process.env.INGESTION_ALERT_EMAIL, now = new Date().toISOString(), repair = async () => ({ resolved: false }) } = {}) {
  if (!to) throw new Error('INGESTION_ALERT_EMAIL is required for unresolved ingestion alerts');
  const { data, error } = await db.from('ingestion_incidents').select('*');
  if (error) throw new Error('Cannot read ingestion incidents: ' + error.message);
  const prior = new Map((data || []).map(row => [row.employer_id, row]));
  for (const entry of run.summary.employers) {
    if (prior.get(entry.employer_id)?.last_run_at && run.started_at &&
      Date.parse(prior.get(entry.employer_id).last_run_at) > Date.parse(run.started_at)) continue;
    const incident = nextIncident(prior.get(entry.employer_id), entry, run.run_id, now);
    if (!incident) continue;
    incident.last_run_at = run.started_at || incident.last_run_at || now;
    const { error: saveError } = await db.from('ingestion_incidents').upsert(incident, { onConflict: 'employer_id' });
    if (saveError) throw new Error('Cannot save ingestion incident: ' + saveError.message);
    if (incident.resolved_at || incident.emailed_at || incident.consecutive_failures < 2) continue;
    const recovery = await repair(incident, entry);
    if (recovery.pending) continue;
    if (recovery.resolved) {
      const { error: resolvedError } = await db.from('ingestion_incidents').update({ resolved_at: now, consecutive_failures: 0 }).eq('employer_id', incident.employer_id).eq('incident_id', incident.incident_id);
      if (resolvedError) throw new Error('Cannot record recovered incident: ' + resolvedError.message);
      continue;
    }
    // Stable incident id allows Resend to deduplicate a retry if delivery succeeds
    // but recording its acknowledgement fails. Persist only after acceptance.
    await sendEmail({ to, subject: `URGENT — ROOK job ingestion needs attention: ${entry.name}`,
      idempotencyKey: `ingestion-${incident.incident_id}`,
      html: `<h1>URGENT — ROOK needs your attention</h1><p>Automatic recovery has not resolved the job source for <strong>${escape(entry.name)}</strong>.</p><p>Status: ${escape(entry.status)}. ${escape(entry.error || 'Extraction remained incomplete or unsupported on consecutive checks.')}</p><p>Automatic action: the configured source was checked again; safe source-read retries were attempted where applicable. Missing jobs from incomplete snapshots are not closed.</p><p>OpenAI recovery result: ${escape(recovery.reason || recovery.action || 'No permitted repair was verified')}.</p><p>Next action: review the official careers source, adapter, and recorded run ${escape(run.run_id)}. No source identity or production code was changed automatically.</p>` });
    const { error: sentError } = await db.from('ingestion_incidents').update({ emailed_at: now }).eq('employer_id', incident.employer_id).eq('incident_id', incident.incident_id);
    if (sentError) throw new Error('Email accepted but incident receipt failed: ' + sentError.message);
  }
}
module.exports = { nextIncident, checkIngestionHealth };
