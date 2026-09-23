const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDecision, diagnoseIngestion, safeError } = require('./ai/ingestionDiagnosis');
const { executeDecision } = require('./ingestionAiRecovery');
const employer = { id: 'verified', active: true, company_name: 'Example', ats_type: 'workday', ats_identifier: 'verified|wd1|External' };
const response = args => ({ status: 'completed', output: [{ type: 'function_call', name: 'select_ingestion_recovery', arguments: JSON.stringify(args) }] });
test('model cannot expand the repair allow-list, add URLs, SQL, or source identities', () => {
  for (const args of [{ action: 'run_sql', diagnosis: 'Do it' }, { action: 'retry_verified_source', diagnosis: 'Retry', url: 'https://attacker.invalid' }, { action: 'escalate', diagnosis: 1 }]) {
    assert.throws(() => parseDecision(response(args)));
  }
  assert.throws(() => parseDecision({ status: 'incomplete', output: [] }));
  assert.throws(() => parseDecision({ status: 'completed', output: [] }));
  assert.equal(parseDecision(response({ action: 'escalate', diagnosis: 'Unknown schema' })).action, 'escalate');
});
test('runtime uses OpenAI API, bounded strict tool calls, and redacted operational evidence', async () => {
  const prior = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-secret';
  let request;
  try {
    await diagnoseIngestion(employer, { status: 'failed', error: '503 https://example.test?token=secret' }, { fetchImpl: async (url, options) => {
      request = { url, ...JSON.parse(options.body) }; return { ok: true, json: async () => response({ action: 'escalate', diagnosis: 'Needs review' }) };
    } });
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.store, false); assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.tools.length, 1); assert.equal(request.tools[0].strict, true);
    assert(!request.input.includes('token=secret')); assert(!request.input.includes('test-secret'));
    assert.equal(safeError('Bearer abc123 token=secret'), '[redacted] [redacted]');
  } finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; }
});
test('local evidence rejects a model retry of an extraction schema failure', async () => {
  let called = false;
  const result = await executeDecision({ action: 'retry_verified_source' }, employer, { status: 'failed', error: 'Unrecognized extraction schema' }, async () => { called = true; });
  assert.equal(called, false); assert.equal(result.resolved, false);
});
test('permitted repair uses the unchanged employer and cannot close jobs; only verified completion resolves', async () => {
  for (const status of ['completed', 'partial', 'timeout']) {
    const result = await executeDecision({ action: 'sync_without_optional_enrichment' }, employer, { status: 'timeout' }, async (input, budget, options) => {
      assert.deepEqual(input, employer); assert.equal(budget, 60000);
      assert.deepEqual(options, { repairSourceOnly: true, disableClosures: true });
      return { status, counts_complete: status !== 'timeout', metrics: {} };
    });
    assert.equal(result.resolved, status === 'completed');
  }
});
