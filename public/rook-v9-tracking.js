(function(){
  if(window.rookV9Track)return;
  var pixel='1597398388509281',seen=Object.create(null);
  if(!window.fbq){var q=window.fbq=function(){q.callMethod?q.callMethod.apply(q,arguments):q.queue.push(arguments)};window._fbq=q;q.push=q;q.loaded=true;q.version='2.0';q.queue=[];var s=document.createElement('script');s.async=true;s.src='https://connect.facebook.net/en_US/fbevents.js';document.head.appendChild(s)}
  window.fbq('set','autoConfig',false,pixel);window.fbq('init',pixel);window.fbq('trackSingle',pixel,'PageView');
  window.rookV9Track=function(name,params){try{
    var key='rook_v9:'+name+':'+((params&&params.stage)||'event')+':'+(sessionStorage.getItem('rook_v9_token')||'visit');
    if(seen[key])return;seen[key]=true;
    var safe={onboarding_version:'v9'};
    ['stage','source','label','status'].forEach(function(k){var v=params&&params[k];if(typeof v==='string'&&/^[a-z0-9_ -]{1,50}$/i.test(v))safe[k]=v});
    ['count','opportunities','best_match_count'].forEach(function(k){var v=params&&params[k];if(Number.isFinite(v))safe[k]=v});
    if(typeof rookGetStoredAttribution==='function'){var a=rookGetStoredAttribution();['source','medium','campaign','content','term'].forEach(function(k){var v=a['utm_'+k];if(typeof v==='string'&&!/@|https?:\/\//i.test(v))safe['first_touch_'+k]=v.slice(0,100)})}
    if(typeof gtag==='function')gtag('event',name,safe);
    var meta={v9_landing:'ViewContent',v9_checkout_started:'InitiateCheckout',v9_paid_subscription_created:'Subscribe'}[name];
    if(meta)window.fbq('trackSingle',pixel,meta);
  }catch(_){}};
})();
