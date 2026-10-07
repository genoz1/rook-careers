require('dotenv').config();
const fs = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { EmployerDiscoveryPipeline } = require('./discovery/pipeline');
const { SupabaseDiscoveryStore } = require('./discovery/store');
const { createPublicSearchSession, resolveOfficialSource, searchOfficialCareerCandidates } = require('./discovery/sourceResolver');

function parseInput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const result = { input: null, retryDue: false, forceCandidateIds: [], limit: 50, ingestEnrolled: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--input') result.input = argv[++index];
    else if (argv[index] === '--retry-due') result.retryDue = true;
    else if (argv[index] === '--force-candidate-id') result.forceCandidateIds.push(...String(argv[++index] || '').split(',').filter(Boolean));
    else if (argv[index] === '--limit') result.limit = Number(argv[++index]);
    else if (argv[index] === '--ingest-enrolled') result.ingestEnrolled = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.input && !result.retryDue && !result.forceCandidateIds.length) throw new Error('Use --input <signals.json|signals.jsonl|->, --retry-due, or --force-candidate-id <uuid>');
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 50) throw new Error('--limit must be an integer from 1 to 50');
  if (result.forceCandidateIds.length > 50 || result.forceCandidateIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('--force-candidate-id requires at most 50 explicit UUID candidate IDs');
  }
  return result;
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const client = dependencies.client || (dependencies.store ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));
  const store = dependencies.store || new SupabaseDiscoveryStore(client);
  const searchSession = dependencies.searchSession || createPublicSearchSession({ httpFetch: dependencies.httpFetch || fetch });
  const pipeline = dependencies.pipeline || new EmployerDiscoveryPipeline({
    store,
    resolveSource: (signal) => resolveOfficialSource(signal, {
      searchCareers: (companyName, options) => searchOfficialCareerCandidates(companyName, { ...options, searchSession }),
      ...(dependencies.readPage ? { readPage: dependencies.readPage } : {}),
    }),
    ...(dependencies.validate ? { validate: dependencies.validate } : {}),
  });
  const ingestEmployer = dependencies.ingestEmployer || (args.ingestEnrolled ? require('./ingest').ingestEmployer : null);
  const countActiveJobs = dependencies.countActiveJobs || (client ? async (employerId) => {
    const { count, error } = await client.from('jobs').select('id', { count: 'exact', head: true })
      .eq('employer_id', employerId).eq('status', 'active');
    if (error) throw error;
    return count || 0;
  } : null);
  let work = [];
  if (args.input) {
    const text = args.input === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.input, 'utf8');
    work.push(...parseInput(text).map((signal) => ({ signal, options: {} })));
  }
  if (args.retryDue) {
    const due = await store.listDueCandidates(args.limit);
    work.push(...due.map((candidate) => ({ signal: candidate.signal_payload, options: {} })));
  }
  if (args.forceCandidateIds.length) {
    const targeted = await store.listCandidatesByIds(args.forceCandidateIds);
    const found = new Set(targeted.map((candidate) => candidate.id));
    const missing = args.forceCandidateIds.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`Candidate IDs not found: ${missing.join(', ')}`);
    work.push(...targeted.map((candidate) => ({ signal: candidate.signal_payload, options: { force: true, candidateId: candidate.id } })));
  }
  const results = [];
  const seenTargets = new Set();
  for (const item of work) {
    const key = item.options.candidateId || JSON.stringify(item.signal);
    if (seenTargets.has(key) || results.length >= args.limit) continue;
    seenTargets.add(key);
    const { signal, options } = item;
    try {
      const result = await pipeline.processSignal(signal, options);
      const output = {
        company_name: signal.company_name,
        status: result.status,
        candidate_id: result.candidate?.id,
        employer_id: result.employer?.id || null,
        source_type: result.employer?.ats_type || result.candidate?.detected_ats_type || null,
        source_url: result.employer?.careers_url || result.candidate?.careers_url || null,
        validation_status: result.validation?.status || result.candidate?.validation_status || null,
        error_reason: result.candidate?.last_error || null,
        search_provider_trace: result.candidate?.evidence?.search_provider_trace || [],
      };
      if (args.ingestEnrolled && result.status === 'enrolled' && result.employer) {
        const before = countActiveJobs ? await countActiveJobs(result.employer.id) : 0;
        const ingestion = await ingestEmployer(result.employer);
        const after = countActiveJobs ? await countActiveJobs(result.employer.id) : before;
        output.ingestion_status = ingestion.status;
        output.ingestion_error = ingestion.error || null;
        output.active_relevant_jobs = after;
        output.relevant_jobs_inserted = Math.max(0, after - before);
      }
      results.push(output);
      console.log('EMPLOYER_DISCOVERY_RESULT', JSON.stringify(output));
    } catch (error) {
      results.push({ company_name: signal.company_name, status: 'error', error: error.message });
      console.error(`${signal.company_name || '(unknown)'}: ${error.message}`);
    }
  }
  return results;
}

module.exports = { parseInput, parseArgs, run };

if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
