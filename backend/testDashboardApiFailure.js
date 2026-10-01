const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const pages = ['rook-dashboard.html', 'rook-dashboard-v7.html', 'rook-dashboard-v8.html'];

for (const page of pages) {
  test(`${page} fails closed with a retry state and never exposes demo jobs`, () => {
    const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
    assert.match(html, /jobList\.replaceChildren\(\)/, 'static design fixtures are removed before requests');
    assert.match(html, /if \(!profileRes\.ok\) throw new Error\('Profile request failed'\)/, 'profile failures do not masquerade as an empty profile');
    assert.match(html, /We’re having trouble loading your matches right now\. Please try again\./);
    assert.match(html, />Retry<\/button>/);
    assert.match(html, /retryJobsButton[\s\S]*?loadJobs\(\)/);
    assert.match(html, /showJobsLoadError\(\)/);
    assert.doesNotMatch(html, /Showing example matches below|ROOK-Setup-Guide\.pdf to get the backend running/);
    const failure = html.slice(html.lastIndexOf('} catch (err) {'), html.indexOf('window.reloadIndustryJobs'));
    assert.doesNotMatch(failure, /revealDemo\(\)/, 'the API failure branch must not reveal static rows');
  });
}

test('rook-search.html also fails closed without exposing its dormant design rows', () => {
  const html = fs.readFileSync(path.join(publicDir, 'rook-search.html'), 'utf8');
  assert.match(html, /jobList\.replaceChildren\(\)/);
  assert.match(html, /data-demo="false"/);
  assert.match(html, /We’re having trouble loading your matches right now\. Please try again\./);
  assert.match(html, />Retry<\/button>/);
  assert.match(html, /showJobsLoadError\(\)/);
  const failure = html.slice(html.lastIndexOf('} catch (err) {'), html.indexOf('window.reloadSearchJobs'));
  assert.doesNotMatch(failure, /revealDemo\(\)|ROOK-Setup-Guide|Could not load Job Search/);
});

test('V9 verified users enter the shared V8 dashboard that now has the safe failure state', () => {
  const signup = fs.readFileSync(path.join(publicDir, 'rook-onboarding-v9-signup.html'), 'utf8');
  assert.match(signup, /location\.href='rook-dashboard-v8\.html\?rook_v8=1&v9=trial_started'/);
  const dashboard = fs.readFileSync(path.join(publicDir, 'rook-dashboard-v8.html'), 'utf8');
  assert.match(dashboard, /rookApplyV9TrialState\(profile\)/);
  assert.match(dashboard, /const res = await rookApiFetch\(jobsUrl\)/);
  assert.match(dashboard, /currentJobs = jobs/);
});

test('résumé upload keeps match-critical analysis and embedding together before scoring while deferring only role suggestions', () => {
  const source = fs.readFileSync(path.join(__dirname, 'routes', 'profile.js'), 'utf8');
  const route = source.slice(source.indexOf('router.post("/resume"'), source.indexOf('router.get("/resume-status"'));
  assert.match(route, /Promise\.allSettled\(\[[\s\S]*?analyzeResume\(resumeText\)[\s\S]*?generateEmbedding\(resumeText\)/);
  assert.ok(route.indexOf('res.json({') < route.indexOf('suggestRoles(resumeStructured)'), 'role suggestions are outside the response critical path');
  assert.ok(route.indexOf('scoreAndStoreForCandidate(supabaseAdmin, updatedProfile)') > route.indexOf('res.json({'), 'matching remains a background step after persisted profile data');
  assert.match(route, /\.eq\("resume_file_path", filePath\)/, 'late role suggestions cannot overwrite a newer résumé');
});
