const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const sent = [];
const sender = require.resolve('./email/resend');
require.cache[sender] = { id: sender, filename: sender, loaded: true, exports: { sendEmail: async m => sent.push(m) } };
const { sendDigestForCandidate, renderDigestHtml } = require('./email/dailyDigest');
const profile = { id: 'test', email: 'test@example.com', home_lat: 28.92, home_lng: -81.92, home_state: 'FL', subscription_status: 'active' };
const row = (id, age = 0) => ({ overall_score: 80, jobs: { id, title_original: id, company_name: 'Employer', location_raw: 'Florida, United States', state: 'FL', job_lat: 28.92, job_lng: -81.92, first_seen_at: new Date(Date.now() - age * 86400000).toISOString() } });
async function scenario(freshCount, fallbackCount, failure, access = "active") {
  const candidate = { ...profile, subscription_status: access };
  const fresh = Array.from({ length: freshCount }, (_, i) => row(`fresh-${i}`));
  const fallback = Array.from({ length: fallbackCount }, (_, i) => row(`recent-${i}`, i + 2));
  let calls = 0;
  const client = createClient('https://example.supabase.co', 'test-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async input => {
    const url = new URL(input); calls++;
    if (url.pathname === '/rest/v1/jobs') {
      assert.equal(url.searchParams.get('select'), '*');
      assert.equal(url.searchParams.get('status'), 'eq.active');
      assert.equal(url.searchParams.get('moderation_status'), 'eq.approved');
      if (failure === 'details') return new Response(JSON.stringify({ message: 'database unavailable' }), { status: 400 });
      const ids = url.searchParams.get('id').slice(4, -1).split(',');
      assert(ids.length <= 5 - freshCount);
      return new Response(JSON.stringify(fallback.filter(r => ids.includes(r.jobs.id)).map(r => r.jobs).reverse()), { status: 200 });
    }
    assert.equal(url.pathname, '/rest/v1/candidate_job_matches');
    const q = url.searchParams;
    assert.equal(q.get('select'), q.has('jobs.first_seen_at') ? '*,jobs!inner(*)' : 'overall_score,recommendation,jobs!inner(id,first_seen_at,location_raw,state,job_lat,job_lng,location_evidence)');
    assert.equal(q.get('limit'), '200');
    for (const [key, value] of Object.entries({ candidate_id: 'eq.test', dismissed: 'eq.false', 'jobs.status': 'eq.active', 'jobs.moderation_status': 'eq.approved' })) assert.equal(q.get(key), value);
    const isFresh = q.has('jobs.first_seen_at');
    assert.equal(q.get('order'), isFresh ? 'overall_score.desc' : 'jobs(first_seen_at).desc');
    assert.equal(q.get('jobs.order'), null, 'must order parent matches, not only the embedded jobs');
    if (failure === (isFresh ? 'fresh' : 'fallback')) return new Response(JSON.stringify({ message: 'database unavailable' }), { status: 400 });
    // Model the database ordering, including duplicate fresh rows and ineligible rows.
    const rows = isFresh ? fresh : [...fresh, ...fallback, { ...row('low-score', 1), overall_score: 59 }, { ...row('distant', 1), jobs: { ...row('distant').jobs, job_lat: 40, job_lng: -120 } }].sort((a, b) => b.jobs.first_seen_at.localeCompare(a.jobs.first_seen_at));
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } } });
  const before = sent.length;
  if (failure) {
    await assert.rejects(sendDigestForCandidate(client, candidate, 'https://rookcareers.com'), /Could not load .*: database unavailable/);
    assert.equal(sent.length, before);
    return;
  }
  const result = await sendDigestForCandidate(client, candidate, 'https://rookcareers.com');
  const count = Math.min(5, freshCount + fallbackCount);
  assert.equal(calls, freshCount >= 5 ? 1 : 2 + (fallbackCount > 0 ? 1 : 0));
  assert.equal(result.sent, count > 0);
  assert.equal(sent.length - before, count > 0 ? 1 : 0);
  if (!count) { assert.equal(result.reason, 'no_qualifying_matches'); return; }
  assert.equal(result.jobCount, count);
  const html = sent.at(-1).html;
  const selected = [...fresh, ...fallback].slice(0, 5);
  const full = selected.map(r => ({ ...r.jobs, match: { overall_score: r.overall_score, excellent_match: false, recommendation: r.recommendation } }));
  const subscribed = require('./matching').hasFullAccess(candidate);
  const emailJobs = subscribed ? full : full.map(require('./redaction').redactForNonSubscriber);
  assert.equal(html, renderDigestHtml({ name: candidate.name, jobs: emailJobs, appBaseUrl: 'https://rookcareers.com', subscribed, hasNewJobs: freshCount > 0 }));
  if (!subscribed) { assert(!html.includes('Employer')); return; }
  const expected = selected.map(r => r.jobs.id);
  let previous = -1;
  for (const id of expected) { const pos = html.indexOf(`>${id}<`); assert(pos > previous, `${id} appears in expected selection order`); previous = pos; }
  for (const id of ['low-score', 'distant', ...fallback.slice(Math.max(0, 5 - freshCount)).map(r => r.jobs.id)]) assert(!html.includes(`>${id}<`));
}
async function run() {
  for (let n = 0; n <= 4; n++) { await scenario(n, 8); await scenario(n, 0); await scenario(n, 1); }
  await scenario(5, 8);
  await scenario(0, 0, 'fresh');
  await scenario(0, 8, 'fallback');
  await scenario(0, 8, 'details');
  await scenario(0, 8, null, null);
  await scenario(3, 8, null, null);
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    let intervals = 0, sends = 0, writes = 0;
    const originalInterval = global.setInterval;
    global.setInterval = (...args) => { const t = originalInterval(...args); if (t.hasRef()) intervals++; return t; };
    process.exit = () => { throw Error('Forced exit is prohibited'); };
    require('dotenv').config = () => ({});
    const sender = require.resolve('./backend/email/resend');
    require.cache[sender] = { id: sender, filename: sender, loaded: true, exports: { sendEmail: async () => { sends++; } } };
    const p = ${JSON.stringify(profile)};
    const r = ${JSON.stringify(row('lifecycle'))};
    require('@supabase/supabase-js').createClient = () => ({ from(table) {
      if (table === 'candidate_profiles') return { select: () => ({ not: async () => ({ data: [p], error: null }) }), update: () => ({ eq: async () => { writes++; return { error: null }; } }) };
      const q = { select: () => q, eq: () => q, gte: () => q, order: () => q, limit: async () => ({ data: [r], error: null }) }; return q;
    } });
    process.on('beforeExit', () => { assert.equal(sends, 1); assert.equal(writes, 1); assert.equal(intervals, 0); assert(!require.cache[require.resolve('./backend/routes/jobs')]); console.log('NATURAL_EXIT_NO_REFERENCED_TIMERS'); });
    require('./backend/sendDigest');
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 8000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Digest run complete\. Sent 1, skipped 0, out of 1/);
  assert.match(child.stdout, /NATURAL_EXIT_NO_REFERENCED_TIMERS/);
  console.log('Daily digest reliability: 21 fallback/error/access scenarios and natural CLI exit passed (all sends mocked)');
}
run().catch(err => { console.error(err); process.exitCode = 1; });
