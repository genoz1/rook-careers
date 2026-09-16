// V7-only orchestration. Payment, email verification, résumé parsing and
// dashboard rendering remain the existing implementations.
let rookV7Snapshot = null;
let rookV7Unlocked = false;
let rookV7Client;
function rookV7Auth() {
  if (typeof rookSupabase !== 'undefined') return rookSupabase;
  return rookV7Client ||= window.supabase.createClient(window.ROOK_CONFIG.SUPABASE_URL,window.ROOK_CONFIG.SUPABASE_ANON_KEY);
}
async function rookV7Request(path, options={}) {
  const {data:{session}} = await rookV7Auth().auth.getSession();
  return fetch('/api/v7'+path, {...options, headers:{...options.headers,'X-ROOK-V7':sessionStorage.getItem('rook_v7_token') || '',...(session ? {Authorization:`Bearer ${session.access_token}`} : {})}});
}
async function rookV7Read() {
  const res=await rookV7Request('/session');
  const data=await res.json();
  if(!res.ok) throw new Error(data.error || 'Unable to load your saved matches.');
  rookV7Snapshot=data; rookV7Unlocked=data.unlocked;
  return data;
}
async function rookV7PrepareAccount() {
  const claim=await rookV7Request('/claim',{method:'POST'});
  if(!claim.ok) throw new Error('Unable to transfer your matches. Return to your V7 dashboard to retry.');
  const data=await rookV7Read();
  if(!data.resume_pending) return;
  // Process the staged file even if this account already has another résumé.
  // An interrupted completion can safely retry the existing upload endpoint.
  {
    const staged=await rookV7Request('/resume');
    if(!staged.ok) throw new Error('Unable to retrieve your résumé. Please retry.');
    const file=new File([await staged.blob()],decodeURIComponent(staged.headers.get('X-Resume-Name') || 'resume.pdf'),{type:staged.headers.get('X-Resume-Type') || 'application/pdf'});
    const fd=new FormData();fd.append('resume',file);
    const {data:{session}}=await rookV7Auth().auth.getSession();
    const processed=await fetch('/api/resume',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`},body:fd});
    if(!processed.ok) throw new Error('Unable to finish your résumé upload. Please retry.');
  }
  const done=await rookV7Request('/resume-complete',{method:'POST'});
  if(!done.ok) throw new Error('Unable to finish saving your résumé. Please retry.');
  await rookV7Read();
}
async function rookV7Init() {
  try {
    await rookV7Read();
    if(new URLSearchParams(location.search).get('trial') === 'started') {
      // Stripe activation can precede the webhook. Access stays masked until
      // the server confirms entitlement; never trust the return URL.
      for(let i=0;!rookV7Unlocked && i<10;i++) {
        await new Promise(resolve=>setTimeout(resolve,2000)); await rookV7Read();
      }
      if(rookV7Unlocked && rookV7Snapshot.profile.subscription_status === 'trialing') {
        if(!sessionStorage.getItem('rook_v7_trial_event')) {
          rookTrackEvent('v7_trial_activated'); sessionStorage.setItem('rook_v7_trial_event','1');
        }
      }
    }
    return 'v7-session';
  } catch(e) {
    const list=document.getElementById('jobListLoading');
    if(list) {list.textContent=e.message+' ';const link=document.createElement('a');link.href='rook-onboarding-v7.html';link.textContent='Start again';list.appendChild(link);}
    return null;
  }
}
async function rookV7Fetch(path,options={}) {
  const data=rookV7Snapshot || await rookV7Read();
  const reply=value=>Promise.resolve(new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}}));
  if(path === '/profile' && !options.method) return reply(data.profile);
  if(path === '/profile' && options.method === 'PUT') {
    const res=await rookV7Request('/location',options);
    if(res.ok) await rookV7Read();
    return res;
  }
  if(path.startsWith('/jobs?')) return reply({jobs:data.jobs});
  if(path === '/new-matches-today-count') return reply({new_today:data.jobs.filter(j=>(j.date_posted || '').slice(0,10)===new Date().toISOString().slice(0,10)).length});
  if(!rookV7Unlocked) {
    if(path === '/applications') return reply([]);
    await rookGoToCheckout('locked_action');
    return new Response('{}',{status:403});
  }
  return rookApiFetch(path,options);
}
async function rookV7Upload(fd) {
  const {data:{session}}=await rookV7Auth().auth.getSession();
  if(!rookV7Snapshot?.profile.user_id) return rookV7Request('/resume',{method:'POST',body:fd});
  return fetch('/api/resume',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`},body:fd});
}
// Override only on V7 pages; all V6 users retain the shared checkout behavior.
async function rookGoToCheckout(source) {
  if(typeof rookTrackEvent === 'function') rookTrackEvent('v7_unlock_clicked',{source:source==='banner'?'banner':'job'});
  const {data:{session}}=await rookV7Auth().auth.getSession();
  window.location.href=session ? 'rook-checkout-v7.html' : 'rook-onboarding-v7-signup.html';
}
