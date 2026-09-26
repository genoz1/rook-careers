const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateApplicationPackage } = require('./ai/applicationPackage');
const { MODEL } = require('./ai/openaiJson');
const resume = 'Example Medical — Sales Representative, 2020–2024. Managed medical sales accounts.';
const pkg = {
  tailored_summary: 'Medical sales representative.',
  work_history: [{ employer: 'Example Medical', title: 'Sales Representative', dates: '2020–2024', bullets: ['Managed medical sales accounts.'] }],
  core_skills: [], education: [], ats_keywords: ['medical sales'],
  cover_letter: 'Application for the sales role.', recruiter_message: 'Interested in the sales role.',
  interview_prep_notes: [{ question: 'Describe your experience.', how_to_answer: 'Discuss your medical sales accounts.' }],
};
const reply = value => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }) });
function setup(t, fetchImpl) {
  const key = process.env.OPENAI_API_KEY, anthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  delete process.env.ANTHROPIC_API_KEY;
  t.mock.method(global, 'fetch', fetchImpl);
  t.after(() => {
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = anthropic;
  });
}
test('Application Package uses existing OpenAI client without Anthropic and preserves output', async t => {
  let calls = 0;
  setup(t, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    const body = JSON.parse(options.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.max_output_tokens, 8000);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, 'application_package');
    assert.deepEqual(body.text.format.schema.required, Object.keys(pkg));
    assert.match(body.instructions, /Never invent employers, job titles, dates, achievements, numbers/);
    assert.match(body.instructions, /EVERY employer\/role actually listed/);
    assert.equal(body.input, `Candidate's résumé:\n\n${resume}\n\n---\n\nJob posting:\nTitle: Sales\nCompany: Example\nDescription: Medical sales`);
    return reply(pkg);
  });
  assert.deepEqual(await generateApplicationPackage(resume, 'Sales', 'Example', 'Medical sales'), pkg);
  assert.equal(calls, 1);
  assert.equal(require.cache[require.resolve('./ai/client')], undefined);
});
test('missing and short résumés fail before any provider call', async t => {
  setup(t, async () => assert.fail('must not call provider'));
  for (const value of [undefined, '', 'short', ' '.repeat(100)]) {
    await assert.rejects(generateApplicationPackage(value), /too short or missing/);
  }
});
test('input caps and unknown job defaults remain unchanged', async t => {
  setup(t, async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.input, `Candidate's résumé:\n\n${'R'.repeat(12000)}\n\n---\n\nJob posting:\nTitle: Unknown\nCompany: Unknown\nDescription: ${'J'.repeat(8000)}`);
    return reply(pkg);
  });
  await generateApplicationPackage('R'.repeat(13000), null, null, 'J'.repeat(9000));
});
test('hollow work history and invalid output are rejected', async t => {
  let value;
  setup(t, async () => reply(value));
  for (const work_history of [[], [{ employer: '', title: '', dates: '', bullets: ['Content'] }], [{ employer: 'Example', title: 'Sales', dates: '', bullets: ['  '] }]]) {
    value = { ...pkg, work_history };
    await assert.rejects(generateApplicationPackage(resume), /usable work history/);
  }
  for (value of [{}, { ...pkg, cover_letter: 42 }, { ...pkg, education: null }]) {
    await assert.rejects(generateApplicationPackage(resume), /Invalid/);
  }
});
test('provider errors and incomplete output propagate without a fallback', async t => {
  let response = { ok: false, status: 401 }, calls = 0;
  setup(t, async url => { assert.equal(url, 'https://api.openai.com/v1/responses'); calls++; return response; });
  await assert.rejects(generateApplicationPackage(resume), /401/);
  response = { ok: true, json: async () => ({ status: 'incomplete' }) };
  await assert.rejects(generateApplicationPackage(resume), /incomplete/);
  assert.equal(calls, 2);
});
