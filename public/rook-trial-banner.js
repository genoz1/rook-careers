// Canonical ROOK protected-preview announcement bar.
//
// Include via <script src="rook-trial-banner.js"></script> anywhere
// after <body> opens. Inserts itself as the first element in <body>.
(function () {
  function init() {
    const bar = document.createElement('div');
    bar.id = 'rookTrialBar';
    bar.style.cssText = 'background:#071E41; color:#fff; text-align:center; padding:10px 16px; font-size:13.5px; font-weight:600; display:flex; align-items:center; justify-content:center; gap:14px; flex-wrap:wrap; position:relative; z-index:100;';

    const text = document.createElement('span');
    text.textContent = 'Browse protected medical sales job matches before choosing access.';

    const cta = document.createElement('a');
    cta.href = 'rook-onboarding-v8.html';
    cta.textContent = 'View Matches';
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
