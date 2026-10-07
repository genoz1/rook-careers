require('dotenv').config();
const { run: runPublic } = require('./runPublicJobDiscovery');
const { run: runCompanies } = require('./runCompanyDiscovery');
const { run: runCandidates } = require('./runEmployerDiscovery');

async function safeStage(name, operation) {
  try {
    return await operation();
  } catch (error) {
    const failure = { status: 'error', stage: name, error: error.message };
    console.error('SCHEDULED_DISCOVERY_STAGE_ERROR', JSON.stringify(failure));
    return failure;
  }
}

async function run() {
  const day = Math.floor(Date.now() / 86_400_000);
  const results = {};
  // Cover all six discovery categories every scheduled cycle. A prior
  // two/three-query rotation left markets dark for a full UTC day and
  // under-discovered companies relative to a complete six-query run.
  results.public_job_activity = await safeStage('public_job_activity', () =>
    runPublic(['--apply', '--limit', '18', '--query-limit', '6', '--ingest-enrolled']));
  results.company_seed = await safeStage('company_seed', () =>
    runCompanies(['--apply', '--limit', '4', '--offset', String((day * 4) % 400), '--ingest-enrolled']));
  results.retries = await safeStage('retries', () =>
    runCandidates(['--retry-due', '--limit', '10', '--ingest-enrolled']));
  console.log('SCHEDULED_DISCOVERY_RESULT', JSON.stringify(results));
  return results;
}

module.exports = { run, safeStage };
if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
