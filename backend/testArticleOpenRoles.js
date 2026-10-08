// Resource + industry-news articles promote live open roles toward membership
// without blocking HTML on the slow SEO job inventory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const views = require('./resources/views');
const newsViews = require('./industryNews/views');

const article = {
  slug: 'territory-planning-basics',
  title: 'Territory Planning Basics',
  category: 'medical-device',
  description: 'A practical overview of territory planning for medical sales professionals.',
  body_html: '<p>Plan coverage first.</p>',
  sources: [{ title: 'Example', url: 'https://example.com/a' }],
  published_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-02T12:00:00Z',
  word_count: 900,
  image_path: '/assets/resources/medical.jpg',
  image_alt: 'Medical device sales',
};

test('resource articles expose an open-roles module with membership attribution', () => {
  const html = views.article(article, []);
  assert.match(html, /data-article-jobs/);
  assert.match(html, /id="article-open-roles"/);
  assert.match(html, /Open Medical Device roles/);
  assert.match(html, /data-jobs-prefer="Medical Device"/);
  assert.match(html, /href="\/jobs\/category\/medical-device-sales-jobs"/);
  assert.match(html, /utm_source=resources/);
  assert.match(html, /utm_campaign=open_roles/);
  assert.match(html, /Membership unlocks employers/);
  assert.match(html, /See matches for my background/);
  // Still crawlable if JS/API fails.
  assert.match(html, /Browse current job previews/);
});

test('industry news articles promote category jobs with news attribution', () => {
  const html = newsViews.article({
    ...article,
    slug: 'device-cleared',
    title: 'Device cleared for U.S. market',
    description: 'A commercially relevant medical device development for sales teams.',
    body_html: '<h2>What changed</h2><p>The product was approved.</p>',
  }, []);
  assert.match(html, /data-article-jobs/);
  assert.match(html, /utm_source=news/);
  assert.match(html, /utm_campaign=open_roles/);
  assert.match(html, /data-jobs-prefer="Medical Device"/);
  assert.match(html, /href="\/jobs\/category\/medical-device-sales-jobs"/);
  assert.match(html, /Looking for your next/);
});

test('client script hydrates open roles from the slim featured jobs API', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/resources.js'), 'utf8');
  assert.match(js, /\/api\/public-featured-jobs/);
  assert.match(js, /article_open_roles_view/);
  assert.match(js, /Unlock employer/);
  assert.match(js, /industry_labels/);
});
