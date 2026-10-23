'use strict';
const crypto=require('node:crypto');
async function googleToken(credentials,httpFetch=fetch){
 const now=Math.floor(Date.now()/1000),enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
 const msg=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
 const assertion=msg+'.'+crypto.sign('RSA-SHA256',Buffer.from(msg),credentials.private_key).toString('base64url');
 const res=await httpFetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(15000)});
 if(!res.ok)throw Error('Google read-only authorization unavailable');const data=await res.json();if(!data.access_token)throw Error('Google token unavailable');return data.access_token;
}
async function collectAnalytics({credentials,gaProperty,gscProperty,httpFetch=fetch}){
 if(!credentials)return {unavailable:'Read-only Google credentials not configured',gscAccess:'Owner must grant the correct ROOK property; denial does not prove the property is absent'};
 const token=await googleToken(credentials,httpFetch),result={capturedAt:new Date().toISOString(),window:'last 28 complete days'};
 const query=async(url,body)=>{const r=await httpFetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Read-only data permission or quota unavailable');return r.json();};
 if(gaProperty&&/^\d+$/.test(gaProperty))try{result.ga4=await query(`https://analyticsdata.googleapis.com/v1beta/properties/${gaProperty}:runReport`,{dateRanges:[{startDate:'28daysAgo',endDate:'yesterday'}],dimensions:[{name:'sessionDefaultChannelGroup'},{name:'sessionSourceMedium'}],metrics:[{name:'sessions'},{name:'totalUsers'},{name:'engagedSessions'},{name:'keyEvents'}],limit:100});}catch{result.ga4={unavailable:'GA4 property permission or quota unavailable'};}
 if(gaProperty&&/^\d+$/.test(gaProperty))try{result.ga4Funnel=await query(`https://analyticsdata.googleapis.com/v1beta/properties/${gaProperty}:runReport`,{dateRanges:[{startDate:'28daysAgo',endDate:'yesterday'}],dimensions:[{name:'sessionSourceMedium'},{name:'eventName'}],dimensionFilter:{filter:{fieldName:'eventName',inListFilter:{values:['acquisition_landing_viewed','v7_account_created','v8_account_created','checkout_started','v7_checkout_started','v8_checkout_started','successful_paid_conversion']}}},metrics:[{name:'eventCount'},{name:'totalUsers'}],limit:200});result.funnelDefinition='Observed GA4 events by source/medium; browser purchase events do not establish payment. Stripe-confirmed subscription and revenue metrics are separate.';}catch{result.ga4Funnel={unavailable:'GA4 funnel events unavailable'};}
 if(gscProperty&&['sc-domain:rookcareers.com','https://rookcareers.com/','https://www.rookcareers.com/'].includes(gscProperty))try{
  const end=new Date(Date.now()-3*86400000).toISOString().slice(0,10),start=new Date(Date.now()-31*86400000).toISOString().slice(0,10);
  result.searchConsole=await query(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscProperty)}/searchAnalytics/query`,{startDate:start,endDate:end,dimensions:['query','page'],rowLimit:100});
 }catch{result.searchConsole={unavailable:'Search Console property access denied or quota unavailable'};}
 if(gaProperty&&/^\d+$/.test(gaProperty)){
  for(const [key,dimensions,metrics,filter] of [
   ['campaignTraffic',['sessionSourceMedium','sessionCampaignName'],['sessions','totalUsers'],null],
   ['campaignFunnel',['sessionSourceMedium','sessionCampaignName','eventName'],['eventCount'],{filter:{fieldName:'eventName',inListFilter:{values:['v8_account_created','v7_account_created','checkout_started','v8_checkout_started','v7_checkout_started','successful_paid_conversion']}}}],
  ])try{result[key]=await query(`https://analyticsdata.googleapis.com/v1beta/properties/${gaProperty}:runReport`,{dateRanges:[{startDate:'28daysAgo',endDate:'yesterday'}],dimensions:dimensions.map(name=>({name})),metrics:metrics.map(name=>({name})),...(filter?{dimensionFilter:filter}:{}),limit:500});}catch{result[key]={unavailable:'Campaign conversion analytics permission or quota unavailable'};}
 }
 return result;
}
module.exports={collectAnalytics,googleToken};
