const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { shortSocialUrl, resolveShortLink, trackSocialText, createRouter } = require('./socialShortLinks');
const { captionFor } = require('./resources/meta');
const { regularPost } = require('./socialContentPlan');
const { buildCandidateResponse } = require('./socialAutomation');
const { buildPostCopy } = require('./socialPostCopy');
const { urlFor } = require('./resources/catalog');

const article = { slug: 'sales-guide', title: 'Sales Guide', category: 'career-advice',
  description: 'A career guide', body_html: '<p>Local article fixture</p>', sources: [],
  published_at: '2026-09-30', updated_at: '2026-09-30', word_count: 100,
  social_copy: { instagram: 'Career advice', facebook: 'Career advice', linkedin: 'Career advice', personal: 'My perspective' } };
const slot = { slot: 'marketing-1', kind: 'education' };
const copy = { headline: article.title, resource_url: urlFor(article.slug), ...article.social_copy };
const extract = text => text.match(/https:\/\/rookcareers\.com\/\S+/)[0];

function resourceDb() {
  return { from() {
    let related = false, offset;
    const q = {
      select() { return q; }, eq() { return q; }, lte() { return q; },
      neq() { related = true; return q; }, order() { return q; }, limit() { return q; },
      range(start) { offset = start; return q; },
      async maybeSingle() { return { data: article }; },
      then(resolve) { resolve({ data: related || offset > 0 ? [] : [article] }); },
    }; return q;
  } };
}

test('SocialChamp rotation redirects to V8 with per-post Facebook and Instagram attribution', async t => {
  const app = express();
  app.use(createRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const platform of ['facebook', 'instagram']) {
    for (const id of ['medical_sales_jobs_only', 'territory_sales_preview']) {
      const short = `/go/socialchamp/${platform}/${id}`;
      const query = '?ref=rotation&topic=jobs&topic=careers&utm_source=stale&utm_source=duplicate&UTM_MEDIUM=stale&utm_campaign=stale&utm_content=stale&utm_source_platform=stale';
      const response = await fetch(origin + short + query, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const target = new URL(response.headers.get('location'));
      assert.equal(target.origin, 'https://rookcareers.com');
      assert.equal(target.pathname, '/rook-onboarding-v8.html');
      assert.deepEqual([...target.searchParams], [
        ['ref', 'rotation'], ['topic', 'jobs'], ['topic', 'careers'],
        ['utm_source', platform], ['utm_medium', 'organic_social'],
        ['utm_campaign', 'socialchamp_rotation'], ['utm_content', id],
      ]);
      assert.equal(resolveShortLink('https://rookcareers.com' + short),
        `https://rookcareers.com/rook-onboarding-v8.html?utm_source=${platform}&utm_medium=organic_social&utm_campaign=socialchamp_rotation&utm_content=${id}`);
    }
  }
  for (const malformed of [
    '/go/socialchamp/facebook/invalid%20id', '/go/socialchamp/instagram/%2F%2Fevil.example',
    '/go/socialchamp/linkedin/medical_sales_jobs_only', '/go/socialchamp/facebook/no.dot',
    '/go/socialchamp/facebook/', `/go/socialchamp/facebook/${'a'.repeat(161)}`,
  ]) {
    const response = await fetch(origin + malformed, { redirect: 'manual' });
    assert.equal(response.status, 404, malformed);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
});

test('SocialChamp crawlers receive branded metadata on the tracked short URL', async t => {
  const app = express();
  app.use(createRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const platform of ['facebook', 'instagram']) {
    const short = `/go/socialchamp/${platform}/medical_sales_jobs_only`;
    for (const agent of ['facebookexternalhit/1.1', 'Meta-ExternalAgent/1.1', 'SocialChampBot/1.0']) {
      const response = await fetch(origin + short, { headers: { 'User-Agent': agent }, redirect: 'manual' });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.match(response.headers.get('vary'), /User-Agent/i);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const html = await response.text();
      assert.match(html, /property="og:title" content="Medical Sales Jobs \| ROOK"/);
      assert.match(html, /property="og:description" content="Medical and veterinary sales opportunities matched from employer career sites\."/);
      assert.match(html, /property="og:type" content="website"/);
      assert.ok(html.includes(`property="og:url" content="https://rookcareers.com${short}"`));
      assert.match(html, /property="og:image" content="https:\/\/rookcareers\.com\/assets\/rook-social-share\.png"/);
      assert.match(html, /name="twitter:card" content="summary_large_image"/);
      assert.doesNotMatch(html, /rook-onboarding-v8\.html|utm_source=/);
    }
    for (const agent of ['Mozilla/5.0', 'Mozilla/5.0 (iPhone) Instagram 350.0.0']) {
      const normal = await fetch(origin + short, { headers: { 'User-Agent': agent }, redirect: 'manual' });
      assert.equal(normal.status, 302);
      assert.equal(normal.headers.get('location'),
        `https://rookcareers.com/rook-onboarding-v8.html?utm_source=${platform}&utm_medium=organic_social&utm_campaign=socialchamp_rotation&utm_content=medical_sales_jobs_only`);
    }
  }
  const second = '/go/socialchamp/facebook/territory_sales_preview?ref=rotation&topic=jobs&utm_source=stale&utm_source=duplicate';
  const preview = await (await fetch(origin + second, { headers: { 'User-Agent': 'facebookexternalhit/1.1' } })).text();
  assert.ok(preview.includes('property="og:url" content="https://rookcareers.com/go/socialchamp/facebook/territory_sales_preview?ref=rotation&amp;topic=jobs"'));
  const normal = await fetch(origin + second, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual' });
  assert.equal(new URL(normal.headers.get('location')).searchParams.get('utm_content'), 'territory_sales_preview');
  assert.ok(fs.existsSync(path.join(__dirname, '../public/assets/rook-social-share.png')));
  const malformed = await fetch(origin + '/go/socialchamp/facebook/invalid%20id', { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
  assert.equal(malformed.status, 404);
  for (const channel of ['facebook','instagram','linkedin','gene-linkedin']) {
    const response = await fetch(origin + `/go/${channel}/resources/sales-guide`, { headers: { 'User-Agent': 'facebookexternalhit/1.1' }, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), resolveShortLink(`https://rookcareers.com/go/${channel}/resources/sales-guide`));
  }
});

test('all actual article destinations redirect and load the existing article with distinct attribution', async t => {
  const app = express();
  app.use(createRouter());
  app.use(require('./resources/routes').createRouter({ db: resourceDb(), jobs: async () => ({}) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const examples = {
    facebook: captionFor(article, 'facebook'),
    instagram: captionFor(article, 'instagram'),
    linkedin: regularPost(slot, 'linkedin', copy),
    'gene-linkedin': trackSocialText(regularPost(slot, 'linkedin', copy), 'gene-linkedin'),
  };
  for (const [destination, text] of Object.entries(examples)) {
    const short = new URL(extract(text));
    assert.equal(short.pathname, `/go/${destination}/resources/sales-guide`);
    assert.equal(short.search, '');
    const redirect = await fetch(origin + short.pathname, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
    const target = new URL(redirect.headers.get('location'));
    assert.equal(target.origin, 'https://rookcareers.com');
    assert.equal(target.pathname, '/resources/sales-guide/');
    assert.equal(target.searchParams.get('utm_source'), destination.includes('linkedin') ? 'linkedin' : destination);
    assert.equal(target.searchParams.get('utm_medium'), 'organic_social');
    assert.equal(target.searchParams.get('utm_campaign'), 'rook_resources');
    assert.equal(target.searchParams.get('utm_content'), 'sales-guide');
    assert.equal(target.searchParams.get('utm_source_platform'), destination.includes('linkedin') ? (destination === 'linkedin' ? 'rook_linkedin' : 'gene_linkedin') : null);
    const page = await fetch(origin + target.pathname + target.search);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Local article fixture/);
    assert.ok(html.includes('rel="canonical" href="https://rookcareers.com/resources/sales-guide/"'));
    assert.doesNotMatch(html, /\/go\//);
  }
  const sitemap = await (await fetch(origin + '/resources/sitemap.xml')).text();
  assert.ok(sitemap.includes('<loc>https://rookcareers.com/resources/sales-guide/</loc>'));
  assert.doesNotMatch(sitemap, /utm_|\/go\//);
  assert.equal(urlFor('sales-guide'), 'https://rookcareers.com/resources/sales-guide/');
  for (const bad of ['/go/facebook/jobs/%2F%2Fevil.com', '/go/toString/jobs/job-1', '/go/linkedin/unknown/slug', '/go/broken']) {
    const response = await fetch(origin + bad, { redirect: 'manual' });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
  }
});

test('featured and general posts retain the actual job, V8 and homepage destinations', () => {
  const job = { id: 'job-123', title_original: 'Sales Representative', location_raw: 'Tampa, FL', company_name: 'Example', employer_id: 'e1' };
  const candidate = buildCandidateResponse(job, 'local-test-secret');
  for (const destination of ['facebook', 'linkedin']) {
    const target = new URL(resolveShortLink(extract(buildPostCopy(candidate, destination))));
    assert.equal(target.pathname, destination === 'facebook' ? '/rook-onboarding-v8.html' : '/jobs/job-123');
    assert.equal(target.searchParams.get('utm_campaign'), 'rook_jobs');
    assert.equal(target.searchParams.get('utm_content'), 'job-123');
  }
  const gene = new URL(resolveShortLink(extract(trackSocialText(buildPostCopy(candidate), 'gene-linkedin'))));
  assert.equal(gene.pathname, '/jobs/job-123');
  assert.equal(gene.searchParams.get('utm_source_platform'), 'gene_linkedin');
  for (const destination of ['facebook', 'linkedin']) {
    const target = new URL(resolveShortLink(extract(regularPost(slot, destination, { headline: 'Careers', text: 'Explore opportunities' }))));
    assert.equal(target.pathname, destination === 'facebook' ? '/rook-onboarding-v8.html' : '/');
    assert.equal(target.searchParams.get('utm_content'), 'marketing-1');
  }
});

test('query parameters, fragments and stable content IDs survive; UTMs are replaced without duplication', () => {
  const input = urlFor('sales-guide') + '?topic=career&tag=a&tag=b&utm_source=old&utm_source=duplicate&UTM_MEDIUM=old&utm_id=stale#tips';
  const short = shortSocialUrl(input, 'facebook');
  assert.doesNotMatch(short, /utm_/i);
  const target = new URL(resolveShortLink(short));
  assert.equal(target.searchParams.get('topic'), 'career');
  assert.deepEqual(target.searchParams.getAll('tag'), ['a', 'b']);
  assert.equal(target.hash, '#tips');
  assert.deepEqual(target.searchParams.getAll('utm_source'), ['facebook']);
  assert.equal(target.searchParams.get('utm_medium'), 'organic_social');
  assert.equal(target.searchParams.get('UTM_MEDIUM'), null);
  assert.equal(target.searchParams.get('utm_id'), null);
  assert.equal(shortSocialUrl(short, 'facebook'), short);
  const legacyTemplate = 'Copy\n\n' + urlFor('sales-guide') + '?utm_source=linkedin&utm_medium=social&utm_campaign=organic&utm_content=resource_article';
  assert.equal(extract(trackSocialText(legacyTemplate, 'gene-linkedin')), 'https://rookcareers.com/go/gene-linkedin/resources/sales-guide');
  assert.throws(() => shortSocialUrl('https://evil.example/jobs/job-1', 'linkedin'));
  assert.throws(() => shortSocialUrl(urlFor('sales-guide'), 'buffer'));
});

test('SEO, sitemap, stored article and generation modules are byte-for-byte unchanged from the base', () => {
  const { execFileSync } = require('node:child_process');
  for (const file of ['backend/resources/catalog.js', 'backend/resources/routes.js', 'backend/resources/views.js', 'backend/resources/worker.js', 'backend/resources/content.js', 'backend/routes/publicPages.js', 'backend/publicSeo.js']) {
    const root = path.resolve(__dirname, '..');
    assert.deepEqual(fs.readFileSync(path.join(root, file)), execFileSync('git', ['show', `6203b2388b664a78dad60b51ee71fe3b23a816c0:${file}`], { cwd: root }));
  }
});
