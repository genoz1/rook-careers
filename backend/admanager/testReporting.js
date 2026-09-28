const assert = require('node:assert/strict');
const { calendarRange } = require('./reportingPeriod');
const fixed = new Date('2026-09-28T02:00:00Z');
assert.deepEqual(calendarRange('today','America/New_York',fixed), {since:'2026-09-27',until:'2026-09-27',time_zone:'America/New_York'});
assert.deepEqual(calendarRange('yesterday','America/New_York',fixed), {since:'2026-09-26',until:'2026-09-26',time_zone:'America/New_York'});
assert.deepEqual(calendarRange('7d','America/New_York',fixed), {since:'2026-09-21',until:'2026-09-27',time_zone:'America/New_York'});
assert.throws(() => calendarRange('bad'), /Invalid/);

process.env.META_ADS_ACCESS_TOKEN='test'; process.env.META_ADS_ACCOUNT_ID='123';
process.env.GOOGLE_ADS_CLIENT_ID='test'; process.env.GOOGLE_ADS_CLIENT_SECRET='test';
process.env.GOOGLE_ADS_REFRESH_TOKEN='test'; process.env.GOOGLE_ADS_CUSTOMER_ID='123';
process.env.REDDIT_ADS_CLIENT_ID='test'; process.env.REDDIT_ADS_CLIENT_SECRET='test';
process.env.REDDIT_ADS_REFRESH_TOKEN='test'; process.env.REDDIT_ADS_ACCOUNT_ID='a2_123';
const meta = require('./clients/meta'), google = require('./clients/google'), reddit = require('./clients/reddit');
let requests=[];
const ok = data => ({ok:true,json:async()=>data});
global.fetch=async (url, options={}) => {
  const body=options.body && !(options.body instanceof URLSearchParams) ? JSON.parse(String(options.body)) : null;
  requests.push({url:String(url),body,signal:options.signal});
  if (String(url).includes('oauth2.googleapis.com') || String(url).includes('reddit.com/api/v1/access_token')) return ok({access_token:'test',expires_in:3600});
  if (String(url).includes('graph.facebook.com')) {
    if (String(url).includes('/act_123/campaigns')) return ok({data:[{id:'m1',name:'Meta',status:'ACTIVE',effective_status:'ACTIVE',insights:{data:[{spend:'3.25',impressions:'100',clicks:'4',actions:[{action_type:'complete_registration',value:'2'}]}]}}]});
    return ok({timezone_name:'America/New_York'});
  }
  if (String(url).includes('googleAds:search')) {
    if (body.query.includes('customer.time_zone')) return ok({results:[{customer:{timeZone:'America/Los_Angeles'}}]});
    return ok({results:[{campaign:{id:'g1',name:'Google',status:'ENABLED'},metrics:{costMicros:'1250000',impressions:'50',clicks:'5',conversions:1}}]});
  }
  if (String(url).includes('/campaigns')) return ok({data:[{id:'r1',name:'Reddit 1',status:'ACTIVE'},{id:'r2',name:'Reddit 2',status:'PAUSED'}]});
  if (String(url).includes('/reports')) return ok({data:{metrics:[{campaign_id:'r1',spend:2000000,impressions:20,clicks:2},{campaign_id:'r2',spend:1000000,impressions:10,clicks:1}]}});
  throw new Error('Unexpected request '+url);
};
(async()=>{
  for (const period of ['today','yesterday','7d']) {
    requests=[];
    const [m,g,r] = await Promise.all([meta.fetchCampaignPerformance(period),google.fetchCampaignPerformance(period),reddit.fetchCampaignPerformance(period)]);
    assert.equal(m[0].conversions,2); assert.equal(m[0].spend_cents,325);
    assert.equal(g[0].conversions,1); assert.equal(g[0].spend_cents,125);
    assert.equal(r.length,2); assert.equal(r[0].spend_cents,200); assert.equal(r[1].spend_cents,100);
    assert.equal(r[0].conversions,null);
    const metaQuery=new URL(requests.find(x=>x.url.includes('/campaigns?')).url).searchParams.get('fields');
    const googleQuery=requests.find(x=>x.body?.query?.includes('FROM campaign')).body.query;
    const redditQuery=requests.find(x=>x.url.includes('/reports')).body.data;
    assert.ok(metaQuery.includes('time_range('));
    assert.ok(googleQuery.includes('segments.date BETWEEN'));
    assert.ok(googleQuery.includes('campaign_budget.resource_name'));
    assert.deepEqual(redditQuery.breakdowns,['CAMPAIGN_ID']);
    assert.ok(requests.find(x=>x.url.includes('/reports')).signal);
    const duration=period==='7d'?6:0;
    const mRange=calendarRange(period,'America/New_York');
    const gRange=calendarRange(period,'America/Los_Angeles');
    const rRange=calendarRange(period,'UTC');
    assert.ok(metaQuery.includes(mRange.since) && metaQuery.includes(mRange.until));
    assert.ok(googleQuery.includes(gRange.since) && googleQuery.includes(gRange.until));
    assert.ok(redditQuery.starts_at.startsWith(rRange.since) && redditQuery.ends_at.startsWith(rRange.until));
  }
  console.log('Ad Manager reporting period tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
