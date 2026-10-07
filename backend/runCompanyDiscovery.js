require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { SupabaseDiscoveryStore } = require('./discovery/store');
const { EmployerDiscoveryPipeline } = require('./discovery/pipeline');
const { resolveOfficialSource } = require('./discovery/sourceResolver');
const { validateSource } = require('./discovery/sourceValidator');
const { discoverCompanyFirstSignals } = require('./discovery/companySources');

function parseArgs(argv) {
  const result = { mode: null, limit: 10, offset: 0, includeVmx: true, includeCurated: true, ingestEnrolled: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--shadow') result.mode = 'shadow';
    else if (argv[index] === '--apply') result.mode = 'apply';
    else if (argv[index] === '--limit') result.limit = Number(argv[++index]);
    else if (argv[index] === '--offset') result.offset = Number(argv[++index]);
    else if (argv[index] === '--vmx-only') result.includeCurated = false;
    else if (argv[index] === '--curated-only') result.includeVmx = false;
    else if (argv[index] === '--ingest-enrolled') result.ingestEnrolled = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!['shadow', 'apply'].includes(result.mode)) throw new Error('Use exactly one of --shadow or --apply');
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 25) throw new Error('--limit must be an integer from 1 to 25');
  if (!Number.isInteger(result.offset) || result.offset < 0) throw new Error('--offset must be a non-negative integer');
  return result;
}

function increment(object, key) { object[key] = (object[key] || 0) + 1; }

async function inspectSignals(signals, { resolveSource = resolveOfficialSource, validate = validateSource } = {}) {
  const results = [];
  for (const signal of signals) {
    if (!signal.company_website) {
      results.push({ company_name: signal.company_name, status: 'unresolved', reason: 'NO_OFFICIAL_WEBSITE' });
      continue;
    }
    try {
      const resolved = await resolveSource(signal);
      let passed = null;
      const attempts = [];
      for (const configuration of resolved.configurations) {
        const validation = await validate(configuration, signal);
        attempts.push({ ats_type: configuration.ats_type, status: validation.status });
        if (validation.ok) { passed = { configuration, validation }; break; }
      }
      results.push({
        company_name: signal.company_name, status: passed ? 'validated' : 'unresolved',
        official_url: resolved.official_url, careers_url: resolved.careers_pages[0] || null,
        configurations_detected: resolved.configurations.length,
        ats_type: passed?.configuration.ats_type || resolved.configurations[0]?.ats_type || null,
        plausible_job_count: passed?.validation.plausible_job_count || 0,
        reason: passed ? null : 'NO_CONFIGURATION_PASSED_MACHINE_VALIDATION', attempts,
      });
    } catch (error) {
      results.push({ company_name: signal.company_name, status: 'unresolved', reason: error.code || error.message });
    }
  }
  return results;
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const client = dependencies.client || (dependencies.store ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));
  const store = dependencies.store || new SupabaseDiscoveryStore(client);
  const knownEmployers = await store.listEmployers();
  const discovery = await (dependencies.discoverSignals || discoverCompanyFirstSignals)({
    knownEmployers, limit: args.limit, offset: args.offset,
    includeVmx: args.includeVmx, includeCurated: args.includeCurated,
  });

  if (args.mode === 'shadow') {
    const inspected = await inspectSignals(discovery.signals, dependencies);
    const summary = {
      mode: 'shadow', ...discovery.stats,
      career_sources_resolved: inspected.filter((item) => item.careers_url).length,
      ats_configurations_detected: inspected.reduce((sum, item) => sum + (item.configurations_detected || 0), 0),
      companies_machine_validated: inspected.filter((item) => item.status === 'validated').length,
      validated_relevant_jobs: inspected.reduce((sum, item) => sum + (item.plausible_job_count || 0), 0),
      unresolved: inspected.filter((item) => item.status === 'unresolved').length,
      results: inspected,
    };
    console.log('COMPANY_DISCOVERY_SHADOW', JSON.stringify(summary));
    return summary;
  }

  const pipeline = dependencies.pipeline || new EmployerDiscoveryPipeline({ store });
  const ingestEmployer = dependencies.ingestEmployer || (args.ingestEnrolled ? require('./ingest').ingestEmployer : null);
  const results = [];
  for (const signal of discovery.signals) {
    try {
      const outcome = await pipeline.processSignal(signal);
      const item = {
        company_name: signal.company_name, status: outcome.status,
        candidate_id: outcome.candidate?.id || null, employer_id: outcome.employer?.id || null,
        ats_type: outcome.employer?.ats_type || outcome.candidate?.detected_ats_type || null,
        plausible_job_count: outcome.validation?.plausible_job_count || 0,
        validation_status: outcome.validation?.status || outcome.candidate?.validation_status || null,
      };
      if (args.ingestEnrolled && outcome.status === 'enrolled' && outcome.employer) {
        item.ingestion_status = (await ingestEmployer(outcome.employer)).status;
        if (client) {
          const { count, error } = await client.from('jobs').select('id', { count: 'exact', head: true })
            .eq('employer_id', outcome.employer.id).eq('status', 'active');
          if (error) throw error;
          item.active_relevant_jobs = count || 0;
        }
      }
      results.push(item);
    } catch (error) { results.push({ company_name: signal.company_name, status: 'error', reason: error.message }); }
  }
  const statuses = {};
  for (const result of results) increment(statuses, result.status);
  const summary = {
    mode: 'apply', ...discovery.stats, processed: results.length, statuses,
    companies_machine_validated: results.filter((item) => item.validation_status === 'PASS_VALIDATED_SOURCE').length,
    automatically_enrolled: results.filter((item) => item.status === 'enrolled').length,
    relevant_jobs_contributed: results.reduce((sum, item) => sum + (item.active_relevant_jobs || 0), 0),
    unresolved: results.filter((item) => ['unresolved', 'retryable', 'error'].includes(item.status)).length,
    results,
  };
  console.log('COMPANY_DISCOVERY_RESULT', JSON.stringify(summary));
  return summary;
}

module.exports = { parseArgs, inspectSignals, run };

if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
