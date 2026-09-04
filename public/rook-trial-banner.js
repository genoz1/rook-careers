// ROOK trial announcement bar.
//
// Renders a slim bar at the very top of the page advertising the free
// trial, with a real day count pulled from the server — never
// hardcoded, so a change to TRIAL_PERIOD_DAYS updates this bar
// automatically on next load, with no copy edit anywhere. Renders
// nothing at all when the trial is disabled (TRIAL_PERIOD_DAYS=0 or
// unset) or if the config fetch fails — the safe default is no bar,
// never a stale or wrong trial claim.
//
// Include via <script src="rook-trial-banner.js"></script> anywhere
// after <body> opens. Inserts itself as the first element in <body>.
(function () {
  async function init() {
    let days = 0;
    try {
      const res = await fetch('/api/stripe/trial-config');
      if (res.ok) {
        const data = await res.json();
        days = Number(data.trialDays) || 0;
      }
    } catch {
      // Network error — leave days at 0, same safe "no bar" default as
      // a non-ok response.
    }
    if (days <= 0) return; // trial disabled — render nothing at all

    const bar = document.createElement('div');
    bar.id = 'rookTrialBar';
    bar.style.cssText = 'background:#071E41; color:#fff; text-align:center; padding:10px 16px; font-size:13.5px; font-weight:600; display:flex; align-items:center; justify-content:center; gap:14px; flex-wrap:wrap; position:relative; z-index:100;';

    const text = document.createElement('span');
    text.textContent = `Try ROOK Free for ${days} Day${days === 1 ? '' : 's'} — Full Access. Then $29/month. Cancel Anytime.`;

    const cta = document.createElement('a');
    cta.href = 'rook-login.html';
    cta.textContent = 'Start Free Trial';
    cta.style.cssText = 'background:#1463FF; color:#fff; padding:6px 16px; border-radius:999px; font-size:12.5px; font-weight:700; text-decoration:none; white-space:nowrap;';

    bar.appendChild(text);
    bar.appendChild(cta);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
