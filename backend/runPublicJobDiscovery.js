require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { SupabaseDiscoveryStore } = require('./discovery/store');
const { EmployerDiscoveryPipeline } = require('./discovery/pipeline');
const { discoverPublicJobSignals } = require('./discovery/publicJobSignals');
const { inspectSignals, isValidatedSourceStatus } = require('./runCompanyDiscovery');

function parseArgs(argv) {
  const result = { mode: null, limit: 12, queryLimit: 2, ingestEnrolled: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--shadow') result.mode = 'shadow';
    else if (argv[index] === '--apply') result.mode = 'apply';
    else if (argv[index] === '--limit') result.limit = Number(argv[++index]);
    else if (argv[index] === '--query-limit') result.queryLimit = Number(argv[++index]);
    else if (argv[index] === '--ingest-enrolled') result.ingestEnrolled = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!['shadow', 'apply'].includes(result.mode)) throw new Error('Use exactly one of --shadow or --apply');
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 25) throw new Error('--limit must be an integer from 1 to 25');
  if (!Number.isInteger(result.queryLimit) || result.queryLimit < 1 || result.queryLimit > 6) throw new Error('--query-limit must be an integer from 1 to 6');
  return result;
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const client = dependencies.client || (dependencies.store ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));
  const store = dependencies.store || new SupabaseDiscoveryStore(client);
  const knownEmployers = await store.listEmployers();
  const discovery = await (dependencies.discoverSignals || discoverPublicJobSignals)({ knownEmployers, queryLimit: args.queryLimit, signalLimit: args.limit });
  if (args.mode === 'shadow') {
    const inspected = await inspectSignals(discovery.signals, dependencies);
    const summary = {
      mode: 'shadow', ...discovery.stats,
      career_sources_resolved: inspected.filter((item) => item.careers_url).length,
      ats_configurations_detected: inspected.reduce((sum, item) => sum + (item.configurations_detected || 0), 0),
      companies_machine_validated: inspected.filter((item) => item.status === 'validated').length,
      validated_relevant_jobs: inspected.reduce((sum, item) => sum + (item.plausible_job_count || 0), 0),
      unresolved: inspected.filter((item) => item.status === 'unresolved').length, results: inspected,
    };
    console.log('PUBLIC_JOB_DISCOVERY_SHADOW', JSON.stringify(summary)); return summary;
  }
  const pipeline = dependencies.pipeline || new EmployerDiscoveryPipeline({ store });
  const ingestEmployer = dependencies.ingestEmployer || (args.ingestEnrolled ? require('./ingest').ingestEmployer : null);
  const results = [];
  for (const signal of discovery.signals) {
    try {
      const outcome = await pipeline.processSignal(signal);
      const item = { company_name: signal.company_name, status: outcome.status, candidate_id: outcome.candidate?.id || null,
        employer_id: outcome.employer?.id || null, ats_type: outcome.employer?.ats_type || outcome.candidate?.detected_ats_type || null,
        validation_status: outcome.validation?.status || outcome.candidate?.validation_status || null,
        plausible_job_count: outcome.validation?.plausible_job_count || 0 };
      if (args.ingestEnrolled && outcome.status === 'enrolled' && outcome.employer) {
        item.ingestion_status = (await ingestEmployer(outcome.employer)).status;
        if (client) {
          const { count, error } = await client.from('jobs').select('id', { count: 'exact', head: true }).eq('employer_id', outcome.employer.id).eq('status', 'active');
          if (error) throw error; item.active_relevant_jobs = count || 0;
        }
      }
      results.push(item);
    } catch (error) { results.push({ company_name: signal.company_name, status: 'error', reason: error.message }); }
  }
  const statuses = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] || 0) + 1;
  const summary = { mode: 'apply', ...discovery.stats, processed: results.length, statuses,
    companies_machine_validated: results.filter((item) => isValidatedSourceStatus(item.validation_status)).length,
    automatically_enrolled: results.filter((item) => item.status === 'enrolled').length,
    relevant_jobs_contributed: results.reduce((sum, item) => sum + (item.active_relevant_jobs || 0), 0), results };
  console.log('PUBLIC_JOB_DISCOVERY_RESULT', JSON.stringify(summary)); return summary;
}

module.exports = { parseArgs, run };
if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
