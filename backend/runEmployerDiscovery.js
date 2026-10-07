require('dotenv').config();
const fs = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { EmployerDiscoveryPipeline } = require('./discovery/pipeline');
const { SupabaseDiscoveryStore } = require('./discovery/store');

function parseInput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const result = { input: null, retryDue: false, limit: 50 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--input') result.input = argv[++index];
    else if (argv[index] === '--retry-due') result.retryDue = true;
    else if (argv[index] === '--limit') result.limit = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.input && !result.retryDue) throw new Error('Use --input <signals.json|signals.jsonl|-> or --retry-due');
  return result;
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const client = dependencies.client || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const store = dependencies.store || new SupabaseDiscoveryStore(client);
  const pipeline = dependencies.pipeline || new EmployerDiscoveryPipeline({ store });
  let signals = [];
  if (args.input) {
    const text = args.input === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.input, 'utf8');
    signals.push(...parseInput(text));
  }
  if (args.retryDue) {
    const due = await store.listDueCandidates(args.limit);
    signals.push(...due.map((candidate) => candidate.signal_payload));
  }
  const results = [];
  for (const signal of signals.slice(0, args.limit)) {
    try {
      const result = await pipeline.processSignal(signal);
      results.push({ company_name: signal.company_name, status: result.status, candidate_id: result.candidate?.id, employer_id: result.employer?.id || null });
      console.log(`${signal.company_name}: ${result.status}`);
    } catch (error) {
      results.push({ company_name: signal.company_name, status: 'error', error: error.message });
      console.error(`${signal.company_name || '(unknown)'}: ${error.message}`);
    }
  }
  return results;
}

module.exports = { parseInput, parseArgs, run };

if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
