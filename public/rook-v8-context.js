/* Carry an explicit V8 return route through shared authenticated tools.
   No effect on direct legacy/V7 visits, which have no rook_v8 parameter. */
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('rook_v8') !== '1') return;
  const shared = new Set([
    'rook-search.html', 'rook-recruiter-jobs.html', 'rook-tracker.html',
    'rook-saved.html', 'rook-intelligence.html', 'rook-settings.html',
    'rook-resume.html', 'rook-apply.html', 'rook-mobile-menu.html'
  ]);
  function route(link) {
    const raw = link.getAttribute('href');
    if (!raw || raw[0] === '#' || /^(?:mailto:|tel:|javascript:)/i.test(raw)) return;
    let url;
    try { url = new URL(raw, location.href); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    const page = url.pathname.split('/').pop();
    if (page === 'rook-dashboard.html' || page === 'rook-dashboard-v7.html') {
      url.pathname = '/rook-dashboard-v8.html';
    } else if (page === 'rook-job-analysis.html') {
      url.pathname = '/rook-job-analysis-v8.html';
    } else if (page === 'rook-onboarding-v2.html') {
      url.pathname = url.searchParams.get('ob') === 'resume_upload' ? '/rook-resume.html' : '/rook-settings.html';
      url.search = url.pathname.endsWith('rook-settings.html') ? '?section=preferences' : '';
    } else if (page === 'rook-checkout.html') {
      url.pathname = '/rook-checkout-v8.html';
    } else if (page === 'rook-login.html') {
      url.pathname = '/rook-login-v8.html';
    } else if (!shared.has(page)) return;
    if (shared.has(url.pathname.split('/').pop())) url.searchParams.set('rook_v8', '1');
    link.href = url.pathname + url.search + url.hash;
  }
  function updateLinks() { document.querySelectorAll('a[href]').forEach(route); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateLinks);
  else updateLinks();
  // Some links are rendered after initial load (cards, mobile menu, access shell).
  document.addEventListener('click', function (event) {
    const link = event.target.closest && event.target.closest('a[href]');
    if (link) route(link);
  }, true);
  // Shared functions are used by Job Search's locked cards. Keep their
  // existing behavior for everyone except an explicitly marked V8 journey.
  window.rookGoToCheckout = function (source) {
    if (typeof rookTrackEvent === 'function') rookTrackEvent('job_unlock_clicked', { event_category: 'engagement', source: String(source || 'unknown') });
    location.href = window.rookAccessState?.signedIn?'rook-checkout-v8.html':'rook-onboarding-v8.html';
  };
  const requireAuth = window.rookRequireAuth;
  if (typeof requireAuth === 'function') window.rookRequireAuth = function (page = 'rook-login-v8.html') { return requireAuth(page); };
  window.rookStartExistingTrial = function () {
    if (typeof rookTrackEvent === 'function') rookTrackEvent('job_unlock_clicked', { source: 'pretrial_navigation' });
    location.href = window.rookAccessState?.signedIn ? 'rook-checkout-v8.html' : 'rook-onboarding-v8-signup.html';
  };
})();
