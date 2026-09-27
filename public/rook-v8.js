(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const track=(name,extra={})=>{if(typeof gtag==='function')gtag('event',name,{onboarding_version:'v8',...extra});};
  const token=()=>sessionStorage.getItem('rook_v7_token')||'';
  const safeUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'?u.href:null;}catch(_){return null;}};
  let data=null,selectedLocation=null,allJobs=[],busy=false,auth=null;
  const client=()=>auth ||= window.supabase.createClient(window.ROOK_CONFIG.SUPABASE_URL,window.ROOK_CONFIG.SUPABASE_ANON_KEY);
  async function api(path,options={}) {
    const {data:{session}}=await client().auth.getSession();
    const response=await fetch('/api/v8'+path,{...options,headers:{'X-ROOK-V7':token(),...(session?{Authorization:'Bearer '+session.access_token}:{}),...options.headers},cache:'no-store'});
    const json=await response.json();if(!response.ok)throw Error(json.error||'Please try again.');return json;
  }
  function goSignup(source) {track('v8_masked_unlock_interaction',{source});track('v8_signup_reached');location.href='rook-onboarding-v8-signup.html';}
  $('startTrial').onclick=()=>{if(token()&&sessionStorage.getItem('rook_v8_active')===token())goSignup('header');else{$('overlay').hidden=false;$('locationInput').focus();}};
  $('unlockButton').onclick=()=>goSignup('banner');
  const widget=RookLocationWidget.init({inputEl:$('locationInput'),listEl:$('locationList'),statusEl:$('locationStatus'),onSelect:l=>{selectedLocation=l;},onClear:()=>{selectedLocation=null;}});
  $('closeOverlay').onclick=()=>{$('overlay').hidden=true;};
  $('changeLocation').onclick=()=>{$('overlay').hidden=false;$('locationInput').focus();track('v8_overlay_displayed',{source:'change_location'});};
  function age(job){const raw=job.date_posted||job.first_seen_at;if(!raw)return '';const days=Math.max(0,Math.floor((Date.now()-new Date(raw).getTime())/86400000));return Number.isFinite(days)?days===0?'Posted today':days===1?'Posted 1 day ago':`Posted ${days} days ago`:'';}
  function score(job){return job.match?.overall_score??job.match?.preference_fit??0;}
  function card(job,index){
    const revealed=!job.subscription_required;
    const badge=score(job)>=75?'STRONG MATCH':'GOOD MATCH';
    const labels=(job.industry_classification?.labels||[]).join(' / ')||'Sales';
    const place=revealed?(job.location_raw||[job.city,job.state].filter(Boolean).join(', ')||'Location varies'):
      (job.territory_type||(['remote_us','national_us','territory'].includes(job.geography_kind)?'Remote / territory':'Opportunity near you'));
    const distance=Number.isFinite(job.distance_miles)?' · '+job.distance_miles+' mi':'';
    const employer=revealed?job.company_name||'Employer not listed':job.masked_lines?.employer?.join(' ')||'Company information';
    const title=revealed?job.title_original||'Sales opportunity':job.role_type||'Sales opportunity';
    const logo=revealed?`<span class="employer-logo" aria-hidden="true">${esc((employer.match(/[A-Za-z0-9]/)||['R'])[0].toUpperCase())}</span>`:'';
    const url=revealed?safeUrl(job.application_url)||safeUrl(job.source_url):null;
    return `<article class="job-card ${revealed?'revealed':'masked'}" ${revealed?'':'data-locked="true" tabindex="0" role="button" aria-label="Unlock this opportunity"'}>
      <div class="card-top"><span class="badge ${badge==='GOOD MATCH'?'good':''}">${badge}</span><span class="posted">${esc(age(job)||job.freshness_label||'')}</span></div>
      <div class="employer-line">${logo}<div class="company">${esc(employer)}</div></div><h2>${esc(title)}</h2>
      <div class="card-meta"><span>▣ &nbsp;${esc(job.employment_type||'Sales')}</span><span>⌖ &nbsp;${esc(place)}${esc(distance)}</span><span>▥ &nbsp;<span class="category">${esc(labels)}</span></span></div>
      ${revealed&&url?`<a class="card-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-job-link="true">View job →</a>`:revealed?'':`<span class="card-link">Unlock full details →</span>`}</article>`;
  }
  function render(){
    const query=$('jobSearch').value.trim().toLowerCase(),sort=$('sortControl').value;
    let jobs=allJobs.filter(j=>!query || [j.subscription_required?'':j.company_name,j.subscription_required?j.role_type:j.title_original,(j.industry_classification?.labels||[]).join(' ')].some(s=>String(s||'').toLowerCase().includes(query)));
    if(sort==='closest')jobs=[...jobs].sort((a,b)=>(a.distance_miles??Infinity)-(b.distance_miles??Infinity));
    if(sort==='newest')jobs=[...jobs].sort((a,b)=>Date.parse(b.date_posted||b.first_seen_at||0)-Date.parse(a.date_posted||a.first_seen_at||0));
    $('resultHeading').textContent=`${jobs.length} ${jobs.length===1?'opportunity':'opportunities'} near you`;
    $('jobGrid').innerHTML=jobs.map(card).join('')||'<p>No opportunities match that search.</p>';
    const locked=jobs.filter(j=>j.subscription_required).length;
    $('unlockMessage').hidden=!locked;$('lockedCount').textContent=`${locked} more ${locked===1?'opportunity':'opportunities'} waiting for you`;
    $('jobGrid').querySelectorAll('[data-locked]').forEach(el=>{el.onclick=()=>goSignup('job_card');el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();goSignup('job_card');}};});
    $('jobGrid').querySelectorAll('[data-job-link]').forEach(el=>el.onclick=()=>track('v8_revealed_job_clicked'));
  }
  $('jobSearch').oninput=render;$('sortControl').onchange=render;
  async function load(initial=false){
    data=await api('/session'+(initial?'?initial=1':''));allJobs=data.jobs;
    $('locationLine').textContent=data.profile.home_location_label||'Your location';
    $('industryControl').value=data.profile.desired_industries?.[0]||'Diagnostics';
    $('overlay').hidden=true;render();
    if(!window.rookV8PaintTracked){
      track('v8_preview_dashboard_displayed',{unlocked:data.unlocked,job_count:data.count});
      if(!data.unlocked && allJobs.some(j=>j.preview_revealed))track('v8_two_job_reveal_viewed',{revealed_count:Math.min(2,allJobs.filter(j=>j.preview_revealed).length)});
      if(data.unlocked)track('v8_unlocked_dashboard_viewed');
      window.rookV8PaintTracked=true;
    }
    if(data.unlocked){window.location.replace('rook-dashboard-v8.html');return;}
  }
  $('industryControl').onchange=async()=>{
    const control=$('industryControl');control.disabled=true;$('status').textContent='Updating order…';
    try{await api('/preference',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({industry:control.value})});await load();track('v8_industry_preference_changed');$('status').textContent='Preference updated. All qualifying industries remain available.';}
    catch(e){$('status').textContent=e.message;}finally{control.disabled=false;}
  };
  $('searchForm').onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    if(!selectedLocation){$('formError').textContent='Choose a city, state or ZIP from the suggestions.';return;}
    busy=true;const button=$('searchForm').querySelector('.submit');button.disabled=true;button.textContent='Finding your best opportunities…';$('formError').textContent='';
    const progress=$('searchProgress'),progressText=$('searchProgressText');progress.hidden=false;progressText.textContent='Matching your location…';
    const started=Date.now();const timer=setInterval(()=>{const elapsed=Date.now()-started;progressText.textContent=elapsed>12000?'Ranking opportunities…':elapsed>3500?'Prioritizing your industry…':'Matching your location…';},500);
    try{
      const attribution=Object.fromEntries(new URLSearchParams(location.search).entries());
      const result=await api('/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:selectedLocation,industry:$('industryInput').value,attribution})});
      sessionStorage.setItem('rook_v7_token',result.token);sessionStorage.setItem('rook_v8_active',result.token);
      track('v8_overlay_submitted');await load(true);
    }catch(err){$('formError').textContent=err.message;}finally{clearInterval(timer);progress.hidden=true;busy=false;button.disabled=false;button.textContent='Show My Jobs →';}
  };
  async function init(){
    track('v8_dashboard_impression');
    if(token()&&sessionStorage.getItem('rook_v8_active')===token()){
      try{
        if(new URLSearchParams(location.search).get('trial')==='started'){
          for(let n=0;n<10;n++){await load();if(data.unlocked)break;await new Promise(r=>setTimeout(r,2000));}
          if(data.unlocked && data.profile.subscription_status==='trialing' && sessionStorage.getItem('rook_trial_activated_fired')!=='1'){
            if(typeof rookTrackFunnelEvent==='function')rookTrackFunnelEvent('v8_trial_started');
            gtag('event','conversion',{send_to:'AW-18428232873',event_category:'conversion',event_label:'trial_started_dashboard',value:0,currency:'USD'});
            gtag('event','trial_activated',{event_category:'conversion',onboarding_version:'v8'});
            sessionStorage.setItem('rook_trial_activated_fired','1');
          }
          if(data.unlocked)history.replaceState({},'',location.pathname);
        }else await load();return;
      }catch(e){sessionStorage.removeItem('rook_v8_active');}
    }
    $('jobGrid').innerHTML=Array.from({length:9},(_,i)=>`<article class="job-card masked" aria-hidden="true"><div class="card-top"><span class="badge ${i%2?'good':''}">${i%2?'GOOD':'STRONG'} MATCH</span></div><div class="employer-line"><div class="company">${i%2?'Caralume':'Beredicalis'}</div></div><h2>Territory Sales Opportunity</h2><div class="card-meta"><span>▣ &nbsp;Field Sales</span><span>⌖ &nbsp;Opportunity near you</span><span>▥ &nbsp;<span class="category">Sales</span></span></div></article>`).join('');
    $('overlay').hidden=false;track('v8_overlay_displayed');
  }
  init();
})();
