(function () {
  if (window.__rookProductTourLoaded) return;
  window.__rookProductTourLoaded = true;

  const style = document.createElement('style');
  style.textContent = `
    .rook-tour-overlay{display:none;position:fixed;inset:0;z-index:1000;background:rgba(4,20,43,.72);backdrop-filter:blur(2px)}
    .rook-tour-overlay.active{display:block}
    .rook-tour-highlight{position:relative!important;z-index:1002!important;background:#fff!important;color:#062d55!important;box-shadow:0 0 0 5px #39a9ff,0 10px 34px rgba(0,0,0,.35)!important}
    .rook-tour-nav-raised{z-index:1002!important}
    .rook-tour-card{position:fixed;z-index:1003;width:min(360px,calc(100vw - 32px));background:#fff;border-radius:18px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
    .rook-tour-step{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#0877d1;margin-bottom:7px}
    .rook-tour-card h2{font-size:21px;color:#062d55;margin:0 0 8px}.rook-tour-card p{font-size:14px;line-height:1.55;color:#47637c;margin:0 0 18px}
    .rook-tour-actions{display:flex;align-items:center;gap:8px}.rook-tour-actions button{border:0;border-radius:999px;padding:10px 16px;font:700 13px inherit;cursor:pointer}
    .rook-tour-skip{background:transparent;color:#637589;margin-right:auto}.rook-tour-back{background:#edf3f8;color:#062d55}.rook-tour-next{background:#1463ff;color:#fff}
    @media(max-width:900px){.rook-tour-card{left:16px!important;right:16px!important;bottom:98px!important;top:auto!important;width:auto}.rook-tour-highlight{z-index:1004!important}}
  `;
  document.head.appendChild(style);

  if (!document.querySelector('.rm-bottomnav')) {
    document.body.insertAdjacentHTML('beforeend', `<nav class="rm-bottomnav">
      <a href="rook-dashboard.html" class="rm-bn-item rm-active"><span>⌂</span>Home</a>
      <a href="rook-search.html" class="rm-bn-item"><span>⌕</span>Job Search</a>
      <a href="rook-saved.html" class="rm-bn-item"><span>♡</span>Saved</a>
      <a href="rook-settings.html" class="rm-bn-item"><span>◉</span>Profile</a>
    </nav>`);
  }
  document.body.insertAdjacentHTML('beforeend', `<div class="rook-tour-overlay" id="rookProductTourV7" role="dialog" aria-modal="true" aria-labelledby="rookTourV7Title">
    <div class="rook-tour-card" id="rookTourV7Card"><div class="rook-tour-step" id="rookTourV7Step"></div><h2 id="rookTourV7Title"></h2><p id="rookTourV7Body"></p>
      <div class="rook-tour-actions"><button type="button" class="rook-tour-skip" id="rookTourV7Skip">Skip</button><button type="button" class="rook-tour-back" id="rookTourV7Back">Back</button><button type="button" class="rook-tour-next" id="rookTourV7Next">Next</button></div>
    </div></div>`);

  const steps = [
    { href:'rook-dashboard.html', title:'Dashboard', body:'These are personalized recommendations ranked against your profile and preferences.' },
    { href:'rook-search.html', title:'Job Search', body:'Search ROOK’s complete active-job database by company, location, distance, or industry.' },
    { href:'rook-saved.html', title:'Saved Jobs', body:'Save promising roles here so you can quickly return to them later.' },
  ];
  const overlay = document.getElementById('rookProductTourV7');
  const card = document.getElementById('rookTourV7Card');
  let index = 0, user = null, highlighted = null;

  function target(step) {
    const scope = innerWidth <= 900 ? '.rm-bottomnav' : '.side-nav';
    return document.querySelector(`${scope} a[href="${step.href}"]`);
  }
  function clearHighlight() {
    highlighted?.classList.remove('rook-tour-highlight');
    document.querySelector('.rm-bottomnav')?.classList.remove('rook-tour-nav-raised');
    highlighted = null;
  }
  function render() {
    clearHighlight();
    const step = steps[index];
    highlighted = target(step);
    highlighted?.classList.add('rook-tour-highlight');
    if (innerWidth <= 900) document.querySelector('.rm-bottomnav')?.classList.add('rook-tour-nav-raised');
    document.getElementById('rookTourV7Step').textContent = `Step ${index + 1} of ${steps.length}`;
    document.getElementById('rookTourV7Title').textContent = step.title;
    document.getElementById('rookTourV7Body').textContent = step.body;
    document.getElementById('rookTourV7Back').style.visibility = index ? 'visible' : 'hidden';
    document.getElementById('rookTourV7Next').textContent = index === steps.length - 1 ? 'Finish' : 'Next';
    if (innerWidth > 900 && highlighted) {
      const rect = highlighted.getBoundingClientRect();
      card.style.left = `${Math.min(innerWidth - 376, rect.right + 18)}px`;
      card.style.top = `${Math.max(20, Math.min(innerHeight - card.offsetHeight - 20, rect.top - 8))}px`;
    }
  }
  async function complete() {
    clearHighlight();
    overlay.classList.remove('active');
    if (user?.id) localStorage.setItem(`rook_product_tour_completed_${user.id}`, '1');
    try {
      const { error } = await rookSupabase.auth.updateUser({ data:{ rook_product_tour_completed:true } });
      if (error) console.warn('Could not sync product tour completion:', error.message);
    } catch (_) {}
  }
  async function start() {
    try {
      const { data } = await rookSupabase.auth.getUser();
      user = data?.user;
      if (!user || user.user_metadata?.rook_product_tour_completed) return;
      if (localStorage.getItem(`rook_product_tour_completed_${user.id}`) === '1') return;
      overlay.classList.add('active');
      render();
    } catch (_) {}
  }
  document.getElementById('rookTourV7Next').addEventListener('click',()=>index === steps.length-1 ? complete() : (index++,render()));
  document.getElementById('rookTourV7Back').addEventListener('click',()=>{if(index){index--;render();}});
  document.getElementById('rookTourV7Skip').addEventListener('click',complete);
  addEventListener('resize',()=>overlay.classList.contains('active')&&render());
  setTimeout(start,700);
})();
