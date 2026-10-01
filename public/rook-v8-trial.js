(function(){
  'use strict';
  function once(name,key,params){
    try{
      const storageKey=`rook_v8_analytics:${name}:${key||'state'}`;
      if(sessionStorage.getItem(storageKey))return;
      sessionStorage.setItem(storageKey,'1');
    }catch(_){}
    if(typeof rookTrackFunnelEvent==='function')rookTrackFunnelEvent(name,{stage:params?.status||'state'},key);
    else if(typeof rookTrackEvent==='function')rookTrackEvent(name,{onboarding_version:'v8',...params});
  }
  function formatRemaining(ms){
    const total=Math.max(0,Math.ceil(ms/1000));
    const hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),seconds=total%60;
    return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
  }
  function goToUpgrade(){window.location.replace('rook-checkout-v8.html');}
  function goToPostTrial(){window.location.replace('rook-keep-access.html');}
  window.rookApplyV8TrialState=function(profile){
    if(profile?.trial_source!=='v8')return false;
    const key=profile.trial_started_at||'v8';
    if(profile.subscription_status==='active'){
      once('v8_subscription_state',key,{status:'active'});
      return false;
    }
    if(profile.subscription_started_at){
      once('v8_subscription_state',key,{status:profile.subscription_status||'inactive'});
      return false;
    }
    const end=profile.trial_ends_at?new Date(profile.trial_ends_at).getTime():0;
    if(profile.subscription_status!=='trialing'||!Number.isFinite(end)||end<=Date.now()){
      once('v8_trial_expired',key,{status:'expired'});
      goToPostTrial();
      return true;
    }
    once('v8_dashboard_accessed',key,{status:'trialing'});
    if(!document.getElementById('v8TrialStatus')){
      const style=document.createElement('style');
      style.textContent='#v8TrialStatus{position:sticky;top:10px;z-index:30;display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 16px;padding:11px 14px;border:1px solid #bfe0d3;border-radius:13px;background:#effaf6;color:#0b513b;box-shadow:0 7px 18px #17395f12;font:600 12px Inter,sans-serif}#v8TrialStatus strong{display:block;color:#083c2d;font-size:13px}#v8TrialStatus button{flex:0 0 auto;border:0;border-radius:999px;background:#0877ff;color:#fff;padding:9px 13px;font:700 12px Inter,sans-serif;cursor:pointer}@media(max-width:640px){#v8TrialStatus{top:6px;align-items:flex-start;gap:9px;padding:10px 11px}#v8TrialStatus button{padding:8px 10px;font-size:11px}}';
      document.head.appendChild(style);
      const banner=document.createElement('aside');banner.id='v8TrialStatus';banner.setAttribute('aria-live','polite');
      banner.innerHTML='<div><strong>24-hour free access · <span id="v8TrialRemaining"></span> remaining</strong><span>Keep ROOK for $9.99 for your first 30 days.</span></div><button type="button">Keep ROOK</button>';
      banner.querySelector('button').onclick=goToUpgrade;
      document.querySelector('main.main')?.prepend(banner);
    }
    const render=()=>{
      const remaining=end-Date.now();
      if(remaining<=0){once('v8_trial_expired',key,{status:'expired'});goToPostTrial();return false;}
      const value=document.getElementById('v8TrialRemaining');if(value)value.textContent=formatRemaining(remaining);return true;
    };
    if(render()){
      const timer=setInterval(()=>{if(!render())clearInterval(timer)},1000);
      addEventListener('pagehide',()=>clearInterval(timer),{once:true});
    }
    return false;
  };
})();
