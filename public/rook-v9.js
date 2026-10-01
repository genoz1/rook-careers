(()=>{
  'use strict';
  const V9_BUILD='6';
  const coreCss=[...document.querySelectorAll('link[rel="stylesheet"]')].find(link=>/rook-v9\.css(?:\?|$)/.test(link.href));
  if(coreCss)coreCss.href=`rook-v9.css?v=${V9_BUILD}`;
  function ensureFlowDom(){
    const locationScreen=document.querySelector('[data-screen="location"]');
    if(!document.querySelector('[data-screen="matching-intro"]')&&locationScreen)locationScreen.insertAdjacentHTML('afterend','<section class="screen" data-screen="matching-intro"><div class="question-wrap"><div class="illustration" data-art="search"></div><h2>Now let’s find your<br>best matches.</h2><p class="lead">Your next answers help ROOK prioritize the opportunities that best match your interests and experience.</p></div></section>');
    if(!document.querySelector('[data-screen="matching-intro"]'))throw Error('V9 flow document is incomplete.');
    document.body.dataset.v9Build=V9_BUILD;
  }
  ensureFlowDom();
  const workflowCss=document.createElement('link');workflowCss.rel='stylesheet';workflowCss.href='rook-v9-workflow.css?v=1';document.head.appendChild(workflowCss);
  const $=id=>document.getElementById(id),screens=[...document.querySelectorAll('.screen')],button=$('continueButton');
  const taxonomy=[['Diagnostics','Diagnostics / Laboratory'],['Medical Device','Medical Device'],['Pharmaceutical','Pharmaceutical'],['Veterinary','Veterinary / Animal Health'],['Biotech/Life Sciences','Biotech / Life Sciences'],['Healthcare SaaS','Healthcare Technology'],['Dental','Dental'],['Distribution','Distribution'],['Capital Equipment','Capital Equipment']];
  const state={screen:'welcome',location:null,industries:[],years:null,territories:[],count:0,countScope:'global',preview:null,busy:false,countRequest:0};
  const order=['welcome','location','matching-intro','industry','trust','experience','territory','searching','workflow','offer'];
  const art={
    search:`<svg class="floaty" viewBox="0 0 180 130" aria-hidden="true"><g fill="#eaf4ff" stroke="#c8def4"><rect x="14" y="31" width="53" height="68" rx="7"/><rect x="111" y="35" width="52" height="65" rx="7"/></g><g fill="#8fc4ff"><rect x="23" y="43" width="31" height="5" rx="3"/><rect x="120" y="47" width="29" height="5" rx="3"/><rect x="23" y="55" width="21" height="5" rx="3"/></g><circle cx="87" cy="61" r="31" fill="#50a3ff" stroke="#0877ff" stroke-width="7"/><circle cx="87" cy="61" r="19" fill="#d8efff"/><path d="M108 84l25 25" stroke="#075dd2" stroke-width="12" stroke-linecap="round"/></svg>`,
    location:`<svg class="floaty" viewBox="0 0 180 130" aria-hidden="true"><path d="M18 94l35-20 38 13 37-25 34 14-35 23-38-12-37 25z" fill="#e8f4ff" stroke="#b9d7f4"/><path d="M46 87c34-25 64 22 98-14" fill="none" stroke="#0877ff" stroke-width="4" stroke-dasharray="6 6"/><path d="M61 27c-15 0-26 11-26 25 0 21 26 42 26 42s26-21 26-42c0-14-11-25-26-25z" fill="#0877ff"/><circle cx="61" cy="52" r="9" fill="#d9efff"/><path d="M139 47c-11 0-20 9-20 20 0 15 20 31 20 31s20-16 20-31c0-11-9-20-20-20z" fill="#31c995"/><circle cx="139" cy="66" r="7" fill="#e7fff6"/></svg>`,
    industry:`<svg class="floaty" viewBox="0 0 180 130" aria-hidden="true"><g transform="translate(21 21)"><rect width="61" height="42" rx="9" fill="#fff" stroke="#bcd8f1"/><circle cx="18" cy="20" r="9" fill="#0877ff"/><path d="M14 20h8M18 16v8" stroke="#fff" stroke-width="2"/><rect x="33" y="14" width="19" height="5" rx="2" fill="#a9cdf3"/><rect x="33" y="24" width="14" height="5" rx="2" fill="#d1e4f7"/></g><g transform="translate(98 21)"><rect width="61" height="42" rx="9" fill="#fff" stroke="#bcd8f1"/><rect x="11" y="12" width="18" height="18" rx="4" fill="#38b98a"/><rect x="35" y="14" width="16" height="5" rx="2" fill="#a9cdf3"/><rect x="35" y="24" width="12" height="5" rx="2" fill="#d1e4f7"/></g><g transform="translate(39 75)"><rect width="102" height="37" rx="9" fill="#fff" stroke="#bcd8f1"/><path d="M17 25V12h8v13M30 25V8h8v17M43 25V15h8v10" stroke="#0877ff" stroke-width="4"/><rect x="62" y="12" width="27" height="5" rx="2" fill="#a9cdf3"/><rect x="62" y="22" width="20" height="5" rx="2" fill="#d1e4f7"/></g></svg>`,
    connect:`<svg class="floaty" viewBox="0 0 180 130" aria-hidden="true"><circle cx="39" cy="65" r="20" fill="#d9efff" stroke="#0877ff" stroke-width="4"/><circle cx="141" cy="65" r="20" fill="#dcf8ed" stroke="#28b980" stroke-width="4"/><path d="M60 65h56" stroke="#8ac1f4" stroke-width="5" stroke-linecap="round" stroke-dasharray="7 8"/><path d="M105 54l13 11-13 11" fill="none" stroke="#0877ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="39" cy="59" r="6" fill="#0877ff"/><path d="M28 78c4-10 18-10 22 0" fill="#0877ff"/><rect x="132" y="53" width="18" height="23" rx="3" fill="#28b980"/><path d="M136 58h10M136 63h10M136 68h7" stroke="#fff" stroke-width="2"/></svg>`,
    experience:`<svg class="floaty" viewBox="0 0 180 130" aria-hidden="true"><rect x="18" y="45" width="62" height="49" rx="9" fill="#dcefff" stroke="#91c1ee"/><circle cx="42" cy="63" r="9" fill="#0877ff"/><path d="M28 84c5-13 23-13 28 0" fill="#0877ff"/><g transform="translate(91 26)"><rect x="0" y="56" width="18" height="25" rx="3" fill="#87c8ff"/><rect x="24" y="39" width="18" height="42" rx="3" fill="#39ba87"/><rect x="48" y="17" width="18" height="64" rx="3" fill="#0877ff"/></g></svg>`,
    territory:`<svg class="floaty" viewBox="0 0 180 130" aria-hidden="true"><path d="M13 91l39-22 37 12 37-22 41 17-41 23-37-12-38 21z" fill="#e9f5ff" stroke="#bdd9f3"/><path d="M42 85c33-25 68 23 103-14" fill="none" stroke="#0877ff" stroke-width="4" stroke-dasharray="6 6"/><path d="M41 34c-12 0-21 9-21 21 0 16 21 33 21 33s21-17 21-33c0-12-9-21-21-21z" fill="#0877ff"/><circle cx="41" cy="55" r="7" fill="#fff"/><path d="M145 38c-11 0-20 9-20 20 0 15 20 31 20 31s20-16 20-31c0-11-9-20-20-20z" fill="#31c995"/><circle cx="145" cy="58" r="7" fill="#fff"/></svg>`
  };
  document.querySelectorAll('[data-art]').forEach(el=>el.innerHTML=art[el.dataset.art]||art.search);
  $('industryChoices').innerHTML=taxonomy.map(([value,label])=>`<button class="choice" data-value="${value}">${label}</button>`).join('');

  function track(name,params={}){if(typeof rookV9Track==='function')rookV9Track(name,params)}
  function progress(){
    const map={welcome:0,location:1,'matching-intro':2,industry:2,trust:3,experience:3,territory:4,searching:5,workflow:6,offer:6},value=map[state.screen]||0;
    document.querySelectorAll('.segments i').forEach((el,index)=>el.className=index<value?'done':index===value?'active':'');
  }
  function setButton(label,disabled=false,green=false){button.textContent=label+'  →';button.disabled=disabled;button.classList.toggle('green',green);}
  function show(name){
    state.screen=name;screens.forEach(el=>el.classList.toggle('active',el.dataset.screen===name));progress();$('formError').textContent='';
    const labels={welcome:'Try ROOK Today for Free',location:'Continue','matching-intro':'Continue',industry:'Continue',trust:'Continue',experience:'Continue',territory:'Find My Matches',workflow:'See Free Access',offer:'Try ROOK Today for Free'};
    const hide=['searching'].includes(name);document.querySelector('.bottom').hidden=hide;
    setButton(labels[name]||'Continue',!ready(name),name==='offer');
    if(['location','industry','experience','territory'].includes(name))track('v9_question_viewed',{stage:name});
    if(name==='trust')track('v9_value_viewed',{stage:'founder_history'});
    if(name==='matching-intro')track('v9_value_viewed',{stage:'matching_intro'});
    if(name==='workflow')track('v9_value_viewed',{stage:'member_workflow'});
    if(name==='offer')track('v9_offer_view',{opportunities:state.preview?.opportunity_count||state.count});
  }
  function ready(name){return ['welcome','matching-intro','trust','workflow','offer'].includes(name)||name==='location'&&!!state.location||name==='industry'&&state.industries.length>0||name==='experience'&&state.years!=null||name==='territory'&&state.territories.length>0}
  function animateCount(next,label,stage=state.screen){
    next=Math.max(0,Number(next)||0);const from=state.count||next,start=performance.now(),duration=650;state.count=next;$('counterLabel').textContent=label||'current opportunities';
    function frame(now){const p=Math.min(1,(now-start)/duration),ease=1-Math.pow(1-p,3),value=Math.round(from+(next-from)*ease);$('counterNumber').textContent=value.toLocaleString();if(p<1)requestAnimationFrame(frame)}requestAnimationFrame(frame);
    track('v9_counter_refined',{stage,count:next});
  }
  async function request(path,options={}){const response=await fetch('/api/v9'+path,{...options,headers:{'Content-Type':'application/json','X-ROOK-V9':sessionStorage.getItem('rook_v9_token')||'',...options.headers},cache:'no-store'});const json=await response.json();if(!response.ok)throw Error(json.error||'Please try again.');return json}
  function payload(stage){return {stage,location:state.location,industries:state.industries,years:state.years,territories:state.territories,attribution:typeof rookGetStoredAttribution==='function'?rookGetStoredAttribution():Object.fromEntries(new URLSearchParams(location.search))}}
  function refine(stage){
    const requestId=++state.countRequest;track('v9_question_answered',{stage});
    request('/refine',{method:'POST',body:JSON.stringify(payload(stage))}).then(result=>{
      if(requestId!==state.countRequest)return;
      state.countScope='location';
      animateCount(result.count,result.label,stage);
    }).catch(()=>{if(requestId===state.countRequest)$('formError').textContent='Your count is still updating. You can continue.';});
  }
  const widget=RookLocationWidget.init({inputEl:$('locationInput'),listEl:$('locationList'),statusEl:$('locationStatus'),onSelect:location=>{state.location=location;setButton('Continue',false);},onClear:()=>{state.location=null;setButton('Continue',true);}});
  document.querySelectorAll('#industryChoices .choice').forEach(el=>el.onclick=()=>{el.classList.toggle('selected');state.industries=[...document.querySelectorAll('#industryChoices .selected')].map(x=>x.dataset.value);setButton('Continue',!ready('industry'));});
  document.querySelectorAll('#experienceChoices .choice').forEach(el=>el.onclick=()=>{document.querySelectorAll('#experienceChoices .choice').forEach(x=>x.classList.remove('selected'));el.classList.add('selected');state.years=Number(el.dataset.value);setButton('Continue',false);});
  document.querySelectorAll('#territoryChoices .choice').forEach(el=>el.onclick=()=>{el.classList.toggle('selected');state.territories=[...document.querySelectorAll('#territoryChoices .selected')].map(x=>x.dataset.value);setButton('Find My Matches',!ready('territory'));});
  async function finish(){
    show('searching');
    try{const result=await request('/session',{method:'POST',body:JSON.stringify(payload('territory'))});sessionStorage.setItem('rook_v9_token',result.token);state.preview=result.preview;++state.countRequest;if(state.countScope!=='location'){state.countScope='location';animateCount(result.preview.opportunity_count,'opportunities available from your area','final')}show('workflow')}
    catch(error){show('territory');$('formError').textContent=error.message;track('v9_checkout_failure',{stage:'search'});}
  }
  button.onclick=async()=>{
    if(state.busy||!ready(state.screen))return;state.busy=true;button.disabled=true;
    try{
      if(state.screen==='welcome')show('location');
      else if(state.screen==='location'){show('matching-intro');refine('location')}
      else if(state.screen==='matching-intro')show('industry');
      else if(state.screen==='industry'){track('v9_question_answered',{stage:'industry'});show('trust')}
      else if(state.screen==='trust')show('experience');
      else if(state.screen==='experience'){track('v9_question_answered',{stage:'experience'});show('territory')}
      else if(state.screen==='territory'){track('v9_question_answered',{stage:'territory'});await finish()}
      else if(state.screen==='workflow')show('offer');
      else if(state.screen==='offer')location.href='rook-onboarding-v9-signup.html';
    }catch(error){$('formError').textContent=error.message}
    finally{state.busy=false;if(state.screen!=='searching')button.disabled=!ready(state.screen)}
  };
  addEventListener('pagehide',()=>{if(!['offer'].includes(state.screen))track('v9_abandonment',{stage:state.screen})});
  (async()=>{track('v9_landing',{source:'meta_paid_video'});const requestId=++state.countRequest;try{const pool=await request('/pool');if(requestId===state.countRequest)animateCount(pool.opportunities,'current opportunities','landing')}catch(_){if(requestId===state.countRequest)$('counterNumber').textContent='—'}})();
})();
