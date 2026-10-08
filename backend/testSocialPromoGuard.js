// Guards automated Buffer/Meta social copy against retired free-trial
// language and checkout price pitches. Job posts may keep compensation $.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.SOCIAL_SPACING_HMAC_SECRET =
  process.env.SOCIAL_SPACING_HMAC_SECRET || 'test-secret-for-promo-guard';
const {
  findStalePromoClaim,
  assertNoStalePromoClaims,
} = require('./socialPromoGuard');
const { validatePersonalText, PERSONAL_INSTRUCTIONS } = require('./socialMarketingCopy');
const { buildPostCopy } = require('./socialPostCopy');
const { regularPost } = require('./socialContentPlan');
const CLEAN = 'Explore matching medical and veterinary sales roles on ROOK.';

test('clean promotional copy passes', () => {
  assert.equal(findStalePromoClaim(CLEAN), null);
  assert.equal(assertNoStalePromoClaims(CLEAN), CLEAN);
});

test('rejects free-trial and free-access claims', () => {
  const bad = [
    'Start a free trial on ROOK today.',
    'Get free access to medical sales jobs.',
    'Try ROOK for free this week.',
    'Start my free trial and see matches.',
    '24 hours of full free access — no catch.',
    'Join with no credit card required.',
    'Complimentary access while you explore.',
    'Unlock everything for $0.00 this weekend.',
  ];
  for (const text of bad) {
    assert.ok(findStalePromoClaim(text), text);
    assert.throws(() => assertNoStalePromoClaims(text), /stale free-trial|free-access/i);
  }
});

test('rejects checkout price and plan-price pitches by default', () => {
  const bad = [
    'ROOK membership is just $5.99 for a 2-day pass.',
    'Monthly plan starts at $9.99 then $19.99/month.',
    'Grab the 3-month pass before you apply.',
    'First 30 paid days for $9.99.',
  ];
  for (const text of bad) {
    assert.ok(findStalePromoClaim(text), text);
    assert.throws(() => assertNoStalePromoClaims(text), /pricing|plan-price/i);
  }
});

test('allowPricing keeps verified job compensation but still bans free-trial language', () => {
  assert.equal(
    findStalePromoClaim('Base $95,000 · Austin TX', { allowPricing: true }),
    null,
  );
  assert.ok(
    findStalePromoClaim('Start a free trial — salary $95,000', { allowPricing: true }),
  );
  assert.throws(
    () => assertNoStalePromoClaims('No credit card required. OTE $120k', 'job', { allowPricing: true }),
    /stale free-trial|free-access/i,
  );
});

test('personal LinkedIn instructions ban free trial and pricing', () => {
  assert.match(PERSONAL_INSTRUCTIONS, /Never mention free trials/i);
  assert.match(PERSONAL_INSTRUCTIONS, /paid membership only/i);
  assert.match(PERSONAL_INSTRUCTIONS, /2-day\/monthly\/3-month/i);
});

test('personal LinkedIn validator rejects free-trial language', () => {
  const ok = 'I keep narrowing my medical sales search to roles that fit my goals. What would you prioritize next in your search?';
  validatePersonalText(ok);
  assert.throws(
    () => validatePersonalText('I would start a free trial before applying widely. What would you try first?'),
    /stale free-trial|free-access|Unapproved/i,
  );
});

test('job Buffer copy keeps compensation dollars and rejects free-trial marketing', () => {
  const base = {
    post_kind: 'featured',
    title: 'Territory Manager',
    location_display: 'Austin, TX',
    category: 'Medical Device',
    compensation_display: 'Base $95,000',
    job_id: 'job_abc123',
    public_url: 'https://rookcareers.com/jobs/job_abc123',
    public_url_linkedin: 'https://rookcareers.com/jobs/job_abc123?utm_source=linkedin',
  };
  const ok = buildPostCopy({ ...base, marketing: 'A focused medical device sales role worth a closer look.' });
  assert.match(ok, /\$95,000/);
  assert.doesNotMatch(ok, /free trial/i);
  assert.throws(
    () => buildPostCopy({ ...base, marketing: 'Start your free trial and apply today.' }),
    /stale free-trial|free-access/i,
  );
});

test('company marketing posts reject free-trial and price pitches before Buffer', () => {
  const slot = { kind: 'education', slot: 'education' };
  regularPost(slot, 'linkedin', {
    headline: 'Medical & veterinary sales careers',
    linkedin: CLEAN,
  });
  assert.throws(
    () => regularPost(slot, 'linkedin', {
      headline: 'Medical & veterinary sales careers',
      linkedin: 'Start a free trial on ROOK.',
    }),
    /stale free-trial|free-access/i,
  );
  assert.throws(
    () => regularPost(slot, 'facebook', {
      headline: 'Medical & veterinary sales careers',
      facebook: 'Membership is only $5.99.',
    }),
    /pricing|plan-price/i,
  );
});

test('resources and industry-news generators wire the promo guard into social copy', () => {
  const resourceSrc = fs.readFileSync(path.join(__dirname, 'resources/content.js'), 'utf8');
  const newsSrc = fs.readFileSync(path.join(__dirname, 'industryNews/content.js'), 'utf8');
  assert.match(resourceSrc, /assertNoStalePromoClaims\(copy/);
  assert.match(newsSrc, /assertNoStalePromoClaims\(copy/);
  assert.match(resourceSrc, /Never mention free trials/);
  assert.match(newsSrc, /Never mention free trials/);
  // Same gate resources/industry-news apply to each channel caption.
  assert.throws(
    () => assertNoStalePromoClaims('Start a free trial on ROOK and plan your territory.', 'linkedin social copy'),
    /stale free-trial|free-access/i,
  );
  assert.throws(
    () => assertNoStalePromoClaims('Join ROOK for $9.99 this month.', 'facebook social copy'),
    /pricing|plan-price/i,
  );
});

test('approved catalog and social generators do not ship free-trial or checkout-price copy', () => {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'socialApprovedCatalog.json'), 'utf8'),
  );
  for (const entry of catalog) {
    assert.equal(
      findStalePromoClaim(`${entry.headline}\n${entry.body}`),
      null,
      entry.id,
    );
  }
  const instructionSources = [
    fs.readFileSync(path.join(__dirname, 'socialMarketingCopy.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'resources/content.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'industryNews/content.js'), 'utf8'),
  ].join('\n');
  assert.match(instructionSources, /Never mention free trials/i);
  assert.match(instructionSources, /paid membership only/i);
  // Generators ban pitching prices; they must not embed live dollar amounts as post copy.
  assert.doesNotMatch(instructionSources, /\$5\.99|\$9\.99|\$19\.99|\$39\.99/);
});
