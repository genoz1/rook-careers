require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { SupabaseDiscoveryStore } = require('./discovery/store');
const { EmployerDiscoveryPipeline, normalizeCompanyName } = require('./discovery/pipeline');
const { discoverMarketSignals } = require('./discovery/marketSignals');

function parseArgs(argv) {
  const result = { mode: null, retryDue: false, limit: 20, queryLimit: 4 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--shadow') result.mode = 'shadow';
    else if (argv[index] === '--apply') result.mode = 'apply';
    else if (argv[index] === '--retry-due') result.retryDue = true;
    else if (argv[index] === '--limit') result.limit = Number(argv[++index]);
    else if (argv[index] === '--query-limit') result.queryLimit = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!['shadow', 'apply'].includes(result.mode)) throw new Error('Use exactly one of --shadow or --apply');
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 50) throw new Error('--limit must be an integer from 1 to 50');
  if (!Number.isInteger(result.queryLimit) || result.queryLimit < 1 || result.queryLimit > 12) throw new Error('--query-limit must be an integer from 1 to 12');
  return result;
}

function summarizeStatuses(results) {
  return results.reduce((summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    return summary;
  }, {});
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const client = dependencies.client || (dependencies.store ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));
  const store = dependencies.store || new SupabaseDiscoveryStore(client);
  const pipeline = dependencies.pipeline || new EmployerDiscoveryPipeline({ store });
  const knownEmployers = await store.listEmployers();
  const discovery = await (dependencies.discoverSignals || discoverMarketSignals)({
    knownEmployers, queryLimit: args.queryLimit, signalLimit: args.limit,
  });

  if (args.mode === 'shadow') {
    const knownNames = new Set(knownEmployers.map((employer) => normalizeCompanyName(employer.company_name)));
    const existing = discovery.signals.filter((signal) => knownNames.has(normalizeCompanyName(signal.company_name)));
    const unknown = discovery.signals.filter((signal) => !knownNames.has(normalizeCompanyName(signal.company_name)));
    const summary = {
      mode: 'shadow', ...discovery.stats,
      existing_employers: existing.length,
      unknown_employers: unknown.length,
      unknown_with_official_website: unknown.filter((signal) => signal.company_website).length,
      sample_unknown: unknown.slice(0, 10).map((signal) => ({ company_name: signal.company_name, job_title: signal.job_title, company_website: signal.company_website, industry: signal.industry })),
    };
    console.log('MARKET_DISCOVERY_SHADOW', JSON.stringify(summary));
    return summary;
  }

  const results = [];
  for (const signal of discovery.signals) {
    try {
      const result = await pipeline.processSignal(signal);
      results.push({ company_name: signal.company_name, status: result.status, candidate_id: result.candidate?.id || null, employer_id: result.employer?.id || null });
    } catch (error) {
      results.push({ company_name: signal.company_name, status: 'error', error: error.message });
    }
  }
  if (args.retryDue) {
    const due = await store.listDueCandidates(Math.max(0, args.limit - results.length));
    for (const candidate of due) {
      try {
        const result = await pipeline.processSignal(candidate.signal_payload);
        results.push({ company_name: candidate.company_name, status: result.status, candidate_id: result.candidate?.id || candidate.id, employer_id: result.employer?.id || null, retry: true });
      } catch (error) {
        results.push({ company_name: candidate.company_name, status: 'error', error: error.message, retry: true });
      }
    }
  }
  const summary = { mode: 'apply', ...discovery.stats, processed: results.length, statuses: summarizeStatuses(results), results };
  console.log('MARKET_DISCOVERY_RESULT', JSON.stringify(summary));
  return summary;
}

module.exports = { parseArgs, summarizeStatuses, run };

if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
