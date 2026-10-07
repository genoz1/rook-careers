(()=>{'use strict';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const track=(name,extra={})=>{try{if(typeof rookTrackFunnelEvent==='function')rookTrackFunnelEvent(name,extra);else if(typeof gtag==='function')gtag('event',name,{onboarding_version:'v8',...extra});}catch(_){}};
const token=()=>sessionStorage.getItem('rook_v7_token')||'';
let jobs=[],selected=null,busy=false;
const submitButton=$('locationForm').querySelector('button.action');
async function api(path,options={}){
  const {data:{session}}=await rookSupabase.auth.getSession();
  const r=await fetch('/api/v8'+path,{...options,headers:{'X-ROOK-V7':token(),...(session?{Authorization:'Bearer '+session.access_token}:{}),...options.headers},cache:'no-store'});
  const text=await r.text();
  let j=null;
  try{j=text?JSON.parse(text):null;}catch(_){throw Error(r.ok?'Invalid response from server.':'Unable to load jobs. Please try again.');}
  if(!r.ok)throw Error((j&&j.error)||'Unable to load jobs. Please try again.');
  return j;
}
function open(id,source){$(id).hidden=false;document.body.classList.add('dialog-open');if(id==='pricingDialog')track('pricing_paywall_viewed',{source})}
function close(id){$(id).hidden=true;document.body.classList.remove('dialog-open')}
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>close(b.dataset.close));
function choose(plan){
  sessionStorage.setItem('rook_membership_plan',plan);track('membership_plan_selected',{plan});
  rookSupabase.auth.getSession().then(({data})=>location.assign((data.session?'rook-checkout-v8.html':'rook-onboarding-v8-signup.html')+`?plan=${encodeURIComponent(plan)}${location.search?'&'+location.search.slice(1):''}`));
}
document.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>choose(b.dataset.plan));
$('plansHeader').onclick=()=>open('pricingDialog','header');
$('unlockButton').onclick=()=>open('pricingDialog','banner');
$('changeLocation').onclick=()=>{track('change_location_clicked');$('formError').textContent='';open('locationDialog','change_location');$('locationInput').focus()};
const locationWidget=RookLocationWidget.init({
  inputEl:$('locationInput'),listEl:$('locationList'),statusEl:$('locationStatus'),
  onSelect:l=>selected=l,onClear:()=>selected=null
});
function place(j){return j.location_label||j.territory_type||(Number.isFinite(j.distance_miles)?`${j.distance_miles} mi away`:'Location available after unlock')}
function card(j){
  const labels=(j.industry_classification?.labels||[]).join(' / ')||'Medical sales';
  const specialty=j.specialty_label?` · ${j.specialty_label}`:'';
  return `<article class="job" data-locked tabindex="0" role="button" aria-label="View membership options"><div class="top"><span class="badge ${(j.match?.overall_score||0)>=75?'strong':''}">${(j.match?.overall_score||0)>=75?'STRONG MATCH':'CURRENT ROLE'}</span><span class="posted">${esc(j.freshness_label||'Recently posted')}</span></div><div class="company">Employer hidden until unlock</div><h2>${esc(j.role_type||'Medical Sales Representative')}</h2><div class="meta"><span>▣ &nbsp;${esc(j.employment_type||'Sales')}</span><span>⌖ &nbsp;${esc(place(j))}</span><span>▥ &nbsp;${esc(labels)}${esc(specialty)}</span></div><span class="details">View full details →</span></article>`;
}
function skeletons(){$('jobGrid').innerHTML=Array.from({length:9},()=>'<div class="skeleton" aria-hidden="true"></div>').join('')}
function render(){
  const q=$('jobSearch').value.trim().toLowerCase(),shown=jobs.filter(j=>!q||[j.role_type,(j.industry_classification?.labels||[]).join(' '),j.territory_type,j.location_label].some(x=>String(x||'').toLowerCase().includes(q)));
  $('jobGrid').innerHTML=shown.map(card).join('')||'<p>No protected opportunities match that filter.</p>';
  document.querySelectorAll('[data-locked]').forEach(el=>{
    const act=()=>{track('anonymous_job_interaction');open('pricingDialog','job_card')};
    el.onclick=act;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();act()}};
  });
}
function display(result){
  const p=result.preview||result;if(!Array.isArray(p.jobs))throw Error('Invalid response');
  jobs=p.jobs;
  $('geoStatus').textContent=result.geo_status==='failure'
    ?'Approximate location unavailable — showing current U.S. opportunities. Use Change Location to personalize.'
    :`Showing protected opportunities near ${p.profile.home_location_label}.`;
  render();
  track('protected_dashboard_viewed',{geo_status:result.geo_status||'selected',job_count:jobs.length});
  if(result.geo_status)track(result.geo_status==='success'?'ip_geolocation_success':'ip_geolocation_failure');
}
function setSubmitBusy(on,label){
  busy=on;submitButton.disabled=!!on;submitButton.textContent=label||'Update opportunities';
  submitButton.setAttribute('aria-busy',on?'true':'false');
}
function normalizeLocation(place){
  if(!place||typeof place!=='object')return null;
  const state=String(place.stateAbbr||place.state||'').trim().toUpperCase();
  const zip=String(place.zip||'').trim();
  const lat=Number(place.lat),lng=Number(place.lng);
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||!/^[A-Z]{2}$/.test(state)||!/^\d{5}$/.test(zip))return null;
  return {
    label:String(place.label||[place.city,state].filter(Boolean).join(', ')),
    city:String(place.city||''),
    state,
    stateAbbr:state,
    lat,lng,zip
  };
}
$('locationForm').onsubmit=async e=>{
  e.preventDefault();
  if(busy)return;
  $('formError').textContent='';
  const previousJobs=jobs.slice();
  setSubmitBusy(true,'Finding your location…');
  let placeChoice=selected;
  try{
    if(!placeChoice && locationWidget?.resolveFromInput) placeChoice=await locationWidget.resolveFromInput();
    placeChoice=normalizeLocation(placeChoice);
    if(!placeChoice){
      $('formError').textContent='Choose a location from the suggestions.';
      setSubmitBusy(false);return;
    }
    selected=placeChoice;
    const label=placeChoice.label;
    // Close immediately and paint loading state while ranking finishes.
    close('locationDialog');
    setSubmitBusy(true,'Updating opportunities…');
    $('geoStatus').textContent=`Updating opportunities near ${label}…`;
    skeletons();
    const attribution=Object.fromEntries(new URLSearchParams(location.search));
    const stored=typeof rookGetStoredAttribution==='function'?rookGetStoredAttribution():{};
    Object.entries(stored).forEach(([k,v])=>{if(!attribution[k])attribution[k]=v});
    const result=await api('/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:placeChoice,attribution})});
    sessionStorage.setItem('rook_v7_token',result.token);
    display(result);
    track('location_changed');
  }catch(error){
    // Restore prior cards and leave the dialog closed — bouncing back into the
    // city form made successful-looking loads feel broken.
    jobs=previousJobs;
    if(jobs.length)render();
    else $('jobGrid').innerHTML='';
    $('geoStatus').textContent=(error.message||'Could not update that location')+' Use Change Location to try again.';
  }finally{
    setSubmitBusy(false);
  }
};
$('jobSearch').oninput=render;
async function init(){
  track('acquisition_landing_viewed');
  skeletons();
  const {data:{session}}=await rookSupabase.auth.getSession();
  if(session)try{
    const r=await rookApiFetch('/profile');
    if(r.ok&&rookHasFullAccess(await r.json()))return location.replace('rook-dashboard-v8.html');
  }catch(_){}
  try{
    const params=new URLSearchParams(location.search);
    const stored=typeof rookGetStoredAttribution==='function'?rookGetStoredAttribution():{};
    Object.entries(stored).forEach(([k,v])=>{if(!params.has(k))params.set(k,v)});
    const result=await api('/bootstrap?'+params);
    sessionStorage.setItem('rook_v7_token',result.token);
    display(result);
  }catch(_){
    $('geoStatus').textContent='Opportunities are temporarily unavailable. Please refresh to try again.';
    $('jobGrid').innerHTML='';
  }
}
init();
})();
