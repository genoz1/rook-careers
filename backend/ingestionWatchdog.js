// Runs in the web service, independently of scheduled ingestion processes.
// It observes durable run records and delegates only allow-listed, verified
// recovery to ingestionAiRecovery. It never changes source identity or schedules.
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const path = require('node:path');
function runHealth(runs, now = Date.now(), maxGapMs = 20 * 60 * 60 * 1000) {
  const scheduled = runs.filter(r => !r.summary?.manual);
  const newest = scheduled[0];
  if (!newest) return 'No scheduled ingestion run has been recorded.';
  if (now - Date.parse(newest.started_at) > maxGapMs) return 'Scheduled ingestion has stopped reporting within its expected interval.';
  if (!newest.ended_at && now - Date.parse(newest.started_at) > 40 * 60 * 1000) return 'The latest ingestion run has exceeded its maximum duration without recording an exit.';
  if (newest.status === 'failed') return 'The latest ingestion run failed before it could complete.';
  return null;
}
function regressionCheck() {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  return new Promise(resolve => execFile(process.execPath, ['--test',
    'backend/testNewJerseyEvidence.js', 'backend/testIndustryRepair.js', 'backend/testIngestionRecovery.js'],
  { cwd: path.join(__dirname, '..'), env, timeout: 30000, maxBuffer: 1024 * 1024 }, error =>
    resolve(error ? 'The deployed ingestion regression checks failed. A reviewed code repair is required.' : null)));
}
async function systemIncident(db, problem, { to, sendEmail, now = new Date().toISOString(), diagnose = require('./ai/ingestionDiagnosis').diagnoseIngestion }) {
  const { data: prior, error } = await db.from('ingestion_watchdog_state').select('*').eq('id', 1).maybeSingle();
  if (error) throw Error('Cannot read watchdog state: ' + error.message);
  const state = { id: 1, last_checked_at: now, problem,
    incident_id: problem ? (prior?.problem ? prior.incident_id : randomUUID()) : null,
    failure_count: problem ? (prior?.problem ? prior.failure_count + 1 : 1) : 0,
    ai_diagnosis: problem && prior?.problem ? prior.ai_diagnosis : null,
    emailed_at: problem && prior?.problem ? prior.emailed_at : null };
  const { error: saveError } = await db.from('ingestion_watchdog_state').upsert(state);
  if (saveError) throw Error('Cannot save watchdog state: ' + saveError.message);
  if (!problem || state.failure_count < 2 || state.emailed_at) return;
  if (!state.ai_diagnosis) {
    try { state.ai_diagnosis = await diagnose({ company_name: 'ROOK ingestion monitor', ats_type: 'system' }, { status: 'failed', error: problem, attempts: [{}, {}] }); }
    catch (error) { state.ai_diagnosis = { action: 'escalate', diagnosis: 'OpenAI diagnosis unavailable: ' + error.message }; }
    // System-level failures have no employer-scoped allow-listed repair. The
    // model diagnosis is retained, but cannot authorize arbitrary code or SQL.
    const { error: diagnosisError } = await db.from('ingestion_watchdog_state').update({ ai_diagnosis: state.ai_diagnosis }).eq('id', 1).eq('incident_id', state.incident_id);
    if (diagnosisError) throw Error('Cannot save watchdog diagnosis');
  }
  await sendEmail({ to, subject: 'URGENT — ROOK ingestion monitoring requires attention',
    idempotencyKey: 'ingestion-watchdog-' + state.incident_id,
    html: `<h1>URGENT — ROOK needs your attention</h1><p>${problem}</p><p>The independent monitor confirmed the issue on consecutive checks. Normal scheduled recovery has not resolved it. Review the ingestion deployment, scheduler, and durable run records. Existing job data has not been deleted.</p>` });
  const { error: receiptError } = await db.from('ingestion_watchdog_state').update({ emailed_at: now }).eq('id', 1).eq('incident_id', state.incident_id);
  if (receiptError) throw Error('Cannot record watchdog email receipt: ' + receiptError.message);
}
function startIngestionWatchdog() {
  const to = process.env.INGESTION_ALERT_EMAIL || 'gzentko@gmail.com';
  if (!to || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[ingestion-watchdog] Disabled: alert recipient or database configuration missing.');
    return;
  }
  const { createClient } = require('@supabase/supabase-js');
  const { sendEmail } = require('./email/resend');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
    { global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }) } });
  const monitorStarted = Date.now();
  let busy = false, regression = null, tested = false, lastEmergency = null;
  async function check() {
    if (busy) return;
    busy = true;
    try {
      if (!tested) { regression = await regressionCheck(); tested = true; }
      const { data: runs, error } = await db.from('ingestion_runs').select('*').order('started_at', { ascending: false }).limit(100);
      if (error) throw Error('Cannot read run history: ' + error.message);
      // The verified production schedule is overnight, 23:00–05:30 Eastern;
      // its normal daytime gap is 17.5 hours, not a stopped scheduler.
      const gapMinutes = Number(process.env.INGESTION_MAX_GAP_MINUTES || 1200);
      if (!Number.isFinite(gapMinutes) || gapMinutes < 45) throw Error('Invalid ingestion monitoring interval');
      const hasScheduledHistory = (runs || []).some(r => !r.summary?.manual);
      // First deployment has no durable history yet. Allow the next normal
      // overnight window to establish it before declaring a missed schedule.
      const waitingForFirstWindow = !hasScheduledHistory && Date.now() - monitorStarted < gapMinutes * 60000;
      await systemIncident(db, regression || (waitingForFirstWindow ? null : runHealth(runs || [], Date.now(), gapMinutes * 60000)), { to, sendEmail });
      const repair = require('./ingestionAiRecovery').createAiRecovery(db);
      // Process new scheduled observations oldest first, including a previously
      // pending AI diagnosis. Manual acceptance runs do not create incidents.
      for (const run of (runs || []).filter(r => r.ended_at && !r.summary?.manual).slice(0, 2).reverse()) {
        await require('./ingestionHealth').checkIngestionHealth(db, { run_id: run.id, started_at: run.started_at, summary: run.summary }, { to, sendEmail, repair });
      }
      lastEmergency = null;
    } catch (error) {
      console.error('[ingestion-watchdog]', error.message);
      // A database outage must not also disable its email alarm. First failure
      // gets one interval to recover. The stable daily key bounds mail retries
      // while the durable deduplication store itself is unavailable.
      const day = new Date().toISOString().slice(0, 10);
      if (lastEmergency) {
        try {
          await sendEmail({ to, subject: 'URGENT — ROOK ingestion monitor cannot verify health',
            idempotencyKey: 'ingestion-monitor-unavailable-' + day,
            html: '<h1>URGENT — ROOK needs your attention</h1><p>Repeated monitoring attempts failed. The monitor cannot verify ingestion health or save its incident records. Check database availability and the ingestion monitor logs.</p>' });
        } catch (mailError) { console.error('[ingestion-watchdog] Alert delivery failed:', mailError.message); }
      }
      lastEmergency = day;
    } finally { busy = false; }
  }
  const timer = setInterval(check, 15 * 60 * 1000); timer.unref();
  // Give a newly deployed service time to initialize before its first check.
  const initial = setTimeout(check, 60000); initial.unref();
  return () => { clearInterval(timer); clearTimeout(initial); };
}
module.exports = { runHealth, regressionCheck, systemIncident, startIngestionWatchdog };
