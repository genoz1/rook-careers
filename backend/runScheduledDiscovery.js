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
  // Rotate three of the six discovery categories each day so every market
  // (medical, device, diagnostics, pharma/biotech, veterinary, animal health)
  // receives coverage within two UTC days instead of three.
  results.public_job_activity = await safeStage('public_job_activity', () =>
    runPublic(['--apply', '--limit', '12', '--query-limit', '3', '--ingest-enrolled']));
  results.company_seed = await safeStage('company_seed', () =>
    runCompanies(['--apply', '--limit', '4', '--offset', String((day * 4) % 400), '--ingest-enrolled']));
  results.retries = await safeStage('retries', () =>
    runCandidates(['--retry-due', '--limit', '10', '--ingest-enrolled']));
  console.log('SCHEDULED_DISCOVERY_RESULT', JSON.stringify(results));
  return results;
}

module.exports = { run, safeStage };
if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
