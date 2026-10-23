'use strict';
const {MIX,weights}=require('./marketing');
const label=v=>typeof v==='string'&&/^[a-z0-9 _/().-]{1,100}$/i.test(v)?v:'unattributed';
function summarize({analytics={},stripe={},profiles=[],baseline=[],clicks=[],now=Date.now(),launch={}}){
 const available=Boolean(analytics.campaignTraffic&&!analytics.campaignTraffic.unavailable),funnelAvailable=Boolean(analytics.campaignFunnel&&!analytics.campaignFunnel.unavailable);
 const categories=Object.keys(MIX).map(category=>({category,sessions:available?0:null,redirectRequests:0,registrations:funnelAvailable?0:null,checkoutStarts:funnelAvailable?0:null,paidSubscriptions:0,mrrCents:0}));
 const byCategory=campaign=>categories.find(r=>'rook_'+r.category===campaign);
 for(const r of analytics.campaignTraffic?.rows||[]){const c=byCategory(r.dimensionValues[1]?.value);if(c)c.sessions+=Number(r.metricValues[0]?.value)||0;}
 const events=new Map();for(const r of analytics.campaignFunnel?.rows||[]){const campaign=r.dimensionValues[1]?.value,event=r.dimensionValues[2]?.value;if(!byCategory(campaign))continue;const key=campaign+':'+event;events.set(key,(events.get(key)||0)+(Number(r.metricValues[0]?.value)||0));}
 for(const c of categories){if(funnelAvailable){c.registrations=(events.get('rook_'+c.category+':v8_account_created')||0)+(events.get('rook_'+c.category+':v7_account_created')||0);c.checkoutStarts=events.has('rook_'+c.category+':checkout_started')?events.get('rook_'+c.category+':checkout_started'):(events.get('rook_'+c.category+':v8_checkout_started')||0)+(events.get('rook_'+c.category+':v7_checkout_started')||0);}}
 for(const r of clicks){const c=categories.find(c=>c.category===r.result?.category);if(c)c.redirectRequests++;}
 const sourceMap=new Map();for(const sub of stripe.subscriptions||[]){if(!sub.verifiedActive)continue;const p=profiles.find(p=>p.stripe_customer_id===sub.customerId)||{},source=label(p.utm_source),campaign=label(p.utm_campaign),key=source+' / '+campaign;
  const total=sourceMap.get(key)||{source,campaign,activePaidSubscriptions:0,normalizedMrrCents:0};total.activePaidSubscriptions++;total.normalizedMrrCents+=sub.normalizedMonthlyCents??sub.monthlyCents??0;sourceMap.set(key,total);
  const c=byCategory(campaign),existing=baseline.some(r=>r.body.customerId===sub.customerId);
  if(c&&!existing&&sub.created*1000>=Math.max(now-28*86400000,Date.parse(launch.goLiveAt)||now)){c.paidSubscriptions++;c.mrrCents+=sub.normalizedMonthlyCents??sub.monthlyCents??0;}
 }
 const result={capturedAt:new Date(now).toISOString(),paymentEvidence:'stripe_verified',categories,revenueBySource:[...sourceMap.values()],trafficAvailable:available,funnelAvailable,window:'GA4: last 28 complete days; Stripe: current verified active subscriptions, new conversion sample excludes baseline customers and pre-launch starts.',clickDefinition:'Redirect requests excluding recognized preview bots; not unique people or proof of a registration. Some scanners may remain.',attributionDefinition:'Stored first-touch attribution; correlation does not establish causation. Browser purchase events are not payment evidence.'};
 result.policy=weights(result);return result;
}
async function collect(client,store){
 const [analytics,stripe,baseline,launch]=await Promise.all([store.call('get',{kind:'metrics',id:'analytics'}),store.call('get',{kind:'metrics',id:'stripe'}),store.call('list',{kind:'baseline'}),store.call('get',{kind:'config',id:'launch'})]);
 const ids=[...new Set((stripe?.subscriptions||[]).filter(s=>s.verifiedActive).map(s=>s.customerId))];let profiles=[];
 if(ids.length){const r=await client.from('candidate_profiles').select('stripe_customer_id,utm_source,utm_medium,utm_campaign').in('stripe_customer_id',ids);if(r.error)throw Error('Attribution read unavailable');profiles=r.data||[];}
 const clicks=await client.from('rook_acq_events').select('result,created_at').eq('type','social_click').gte('created_at',new Date(Date.now()-28*86400000).toISOString()).limit(10000);if(clicks.error)throw Error('Click read unavailable');
 const result=summarize({analytics:analytics||{},stripe:stripe||{},profiles,baseline,launch:launch||{},clicks:clicks.data||[]});result.clickRowsCapped=(clicks.data||[]).length>=10000;return result;
}
module.exports={summarize,collect};
