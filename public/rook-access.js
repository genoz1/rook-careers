// Navigation only. Server projection and entitlement checks remain authoritative.
(function () {
  if(window.rookAccessReady) return;
  let snapshotValid=false;
  let originalSidebar=null;
  const changedLinks=new Map();
  window.rookRestoreFullNavigation=function(){
    if(window.rookAccessState){window.rookAccessState.full=true;window.rookAccessState.locked=false;}
    const sidebar=document.querySelector('.side-nav');
    if(sidebar && originalSidebar!==null) sidebar.innerHTML=originalSidebar;
    for(const [link,original] of changedLinks){link.href=original.href;link.innerHTML=original.html;}
    changedLinks.clear();
  };
  const stored=()=>{try{return sessionStorage.getItem('rook_v7_token') || localStorage.getItem('rook_v7_return_token') || '';}catch(_){return '';}};
  const token=stored();
  if(token){try{sessionStorage.setItem('rook_v7_token',token);}catch(_){}}
  window.rookMatchesUrl=()=>snapshotValid?'rook-dashboard-v7.html':'rook-dashboard.html';
  window.rookApplyLimitedNavigation=function(){
    const target=rookMatchesUrl();
    const links=[['My Job Matches',target],['Companies We Search','rook-companies.html'],['Pricing','rook-pricing.html'],['About ROOK','rook-about.html'],['For Employers','rook-employers.html']];
    const sidebar=document.querySelector('.side-nav');
    if(sidebar && originalSidebar===null) originalSidebar=sidebar.innerHTML;
    if(sidebar) sidebar.innerHTML=links.map(([label,url])=>`<a href="${url}">${label}</a>`).join('')+'<a href="#" onclick="rookStartExistingTrial();return false;">Start 3-Day Free Trial</a>'+(!window.rookAccessState?.signedIn?'<a href="rook-login.html">Log In</a>':'');
    document.querySelectorAll('a[href]').forEach(link=>{
      if(link.getAttribute('href')==='#') return;
      const path=new URL(link.href,location.href).pathname;
      if(/\/(rook-browse|rook-search|rook-dashboard|rook-onboarding(?:-v[2-7])?)\.html$/.test(path) || path==='/jobs') {
        if(!changedLinks.has(link)) changedLinks.set(link,{href:link.href,html:link.innerHTML});
        link.href=target;
        if(/Find Jobs|Find My Matches|Get Started|Start.*Trial|Dashboard|Job Search|New Search/i.test(link.textContent)) link.textContent='My Job Matches';
      }
    });
  };
  window.rookStartExistingTrial=async function(){
    const state=await window.rookAccessReady;
    if(typeof rookTrackEvent==='function') rookTrackEvent('job_unlock_clicked',{source:'pretrial_navigation'});
    location.href=snapshotValid ? (state.signedIn?'rook-checkout-v7.html':'rook-onboarding-v7-signup.html') : 'rook-checkout.html';
  };
  // Wait for access resolution before following old marketing links. This
  // closes the brief loading race that could otherwise restart onboarding.
  document.addEventListener('click',async event=>{
    const link=event.target.closest?.('a[href]');
    if(!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if(link.getAttribute('href')?.startsWith('#')) return;
    const url=new URL(link.href,location.href);
    if(url.origin!==location.origin || !/\/(rook-browse|rook-search|rook-onboarding(?:-v[2-7])?)\.html$/.test(url.pathname)) return;
    event.preventDefault();
    const state=await window.rookAccessReady;
    location.href=state.locked ? rookMatchesUrl() : url.href;
  },true);
  window.rookAccessReady=(async()=>{
    let session=null,profile=null;
    try{
      if(typeof rookSupabase!=='undefined') session=(await rookSupabase.auth.getSession()).data?.session;
      if(session){const r=await fetch('/api/profile',{headers:{Authorization:'Bearer '+session.access_token}});if(r.ok)profile=await r.json();}
      if(token){
        const r=await fetch('/api/v7/session?summary=1',{headers:{'X-ROOK-V7':token,...(session?{Authorization:'Bearer '+session.access_token}:{})}});
        if(r.ok){const snapshot=await r.json();snapshotValid=true;profile=profile || snapshot.profile;try{localStorage.setItem('rook_v7_return_token',token);}catch(_){}}
      }
    }catch(_){}
    const full=typeof rookHasFullAccess==='function' && rookHasFullAccess(profile);
    const personalized=!!(snapshotValid || profile);
    const state={signedIn:!!session,full,personalized,locked:personalized&&!full};
    window.rookAccessState=state;
    if(state.locked){
      rookApplyLimitedNavigation();
      const restricted=/\/(rook-search|rook-browse)\.html$/.test(location.pathname) || /^\/jobs(?:\/|$)/.test(location.pathname);
      if(restricted) location.replace('/'+rookMatchesUrl());
    }
    return state;
  })();
})();
