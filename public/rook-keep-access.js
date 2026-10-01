(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.RookKeepAccess=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function resolve(profile,now=Date.now()){
    if(profile?.subscription_status==='active')return {redirect:'rook-dashboard-v8.html'};
    const source=profile?.trial_source;
    if(!['v8','v9'].includes(source)||!profile?.trial_started_at)return {error:'This upgrade is available after a verified ROOK free-access period.'};
    if(profile.subscription_started_at)return {error:'This account has already used the introductory month. Manage or restart membership from your dashboard.'};
    const end=profile.trial_ends_at?new Date(profile.trial_ends_at).getTime():NaN;
    if(!Number.isFinite(end))return {error:'Your free-access status could not be confirmed. Please try again.'};
    if(end>now)return {redirect:'rook-dashboard-v8.html'};
    return {
      source,
      endpoint:`/api/stripe/create-${source}-subscription-from-setup`,
      trialKey:profile.trial_started_at,
    };
  }
  return {resolve};
});
