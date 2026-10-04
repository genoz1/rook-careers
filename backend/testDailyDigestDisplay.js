// No network: both PostgREST retrieval and Resend delivery are mocked.
const assert = require('node:assert/strict');
const {createClient} = require('@supabase/supabase-js');
const deliveries = [];
const sender = require.resolve('./email/resend');
require.cache[sender] = {id:sender,filename:sender,loaded:true,exports:{sendEmail:async message => deliveries.push(message)}};
const {sendDigestForCandidate, renderDigestHtml, prepareDigestJobs} = require('./email/dailyDigest');
const {redactForNonSubscriber} = require('./redaction');
const base = 'https://rookcareers.com';
const profile = {id:'fixture-candidate',email:'fixture@example.com',name:'Gene Zentko',
  home_lat:28.92,home_lng:-81.92,home_state:'FL',subscription_status:null,digest_enabled:true};
const titles = ['Medical Sales Representative','Territory Account Manager','Clinical Sales Specialist',
  'Veterinary Sales Representative','Laboratory Account Executive'];
const safeTitles = ['Sales Representative','Account Manager','Clinical Sales Specialist',
  'Veterinary Sales Representative','Laboratory Account Executive'];
const jobs = titles.map((title,i) => ({id:`source-job-${i}`,title_original:title,
  company_name:`PRIVATEBRAND${i}`,city:'Orlando',state:'FL',location_raw:'Orlando, FL',
  job_lat:28.54,job_lng:-81.38,first_seen_at:new Date(Date.now()-3*86400000).toISOString(),
  salary_min:90000,salary_max:120000,compensation_text:'PRIVATE compensation text',
  description_text:'PRIVATE description',source_url:'https://private.example/apply',
  status:'active',moderation_status:'approved'}));
const leakedTitle='Clinical Specialist Manager | Urology - Neuromodulation';
const leakFixture={...jobs[0],id:'distinctive-title',title_original:leakedTitle,
  company_name:'PRIVATE DISTINCTIVE EMPLOYER',description_text:'PRIVATE DISTINCTIVE DESCRIPTION',
  source_url:'https://private.example/distinctive-apply'};
function dbFor(fresh,recent) {
  let reads=0;
  const db=createClient('https://fixture.supabase.co','fixture-key',{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:async input => {
      reads++;
      const url=new URL(input),q=url.searchParams;
      let data;
      if(url.pathname==='/rest/v1/jobs') {
        assert.equal(q.get('select'),'*');
        const ids=q.get('id').slice(4,-1).split(',');
        data=recent.filter(j=>ids.includes(j.id));
      } else {
        assert.equal(url.pathname,'/rest/v1/candidate_job_matches');
        const isFresh=q.has('jobs.first_seen_at');
        assert.equal(q.get('select'),isFresh?'*,jobs!inner(*)':
          'overall_score,recommendation,jobs!inner(id,first_seen_at,location_raw,state,job_lat,job_lng,location_evidence)');
        data=(isFresh?fresh:recent).map(job=>({overall_score:80,recommendation:'Apply',
          jobs:isFresh?job:Object.fromEntries(['id','first_seen_at','location_raw','state','job_lat','job_lng','location_evidence'].map(k=>[k,job[k]]))}));
      }
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    }}});
  return {db,reads:()=>reads};
}
async function send(fresh,recent,recipient=profile) {
  const before=deliveries.length,{db}=dbFor(fresh,recent);
  const result=await sendDigestForCandidate(db,recipient,base);
  return {result,message:deliveries.length>before?deliveries.at(-1):null};
}
async function run() {
  // Preserve the old display contract as a failure fixture. The full unchanged
  // sender was also executed during investigation and reproduced this output.
  const oldEmailJobs=jobs.map(redactForNonSubscriber);
  const broken={html:oldEmailJobs.map(job=>job.title_original || 'Untitled role').join('\n'),
    subject:`${jobs.length} jobs waiting for you on ROOK — see who's hiring`};
  assert.equal((broken.html.match(/Untitled role/g)||[]).length,5);
  assert.equal(broken.subject,"5 jobs waiting for you on ROOK — see who's hiring");
  assert(!broken.html.includes('Orlando'));
  for(const job of jobs) {
    const projected=redactForNonSubscriber(job);
    assert.equal(projected.title_original,undefined);
    assert.equal(projected.location_raw,undefined);
  }

  for(const fresh of [false,true]) {
    const records=jobs.map(j=>({...j,first_seen_at:new Date(Date.now()-(fresh?0:3*86400000)).toISOString()}));
    const {result,message}=await send(fresh?records:[],fresh?[]:records);
    assert.equal(result.jobCount,5);
    assert.equal(result.excludedJobCount,0);
    assert.match(message.subject,/^5 jobs/);
    for(const title of safeTitles) assert(message.html.includes(title));
    assert(message.html.includes('Orlando, FL'));
    assert(message.html.includes('$90,000–$120,000'));
    assert(message.html.includes('Receiving alerts does not require a paid subscription'));
    assert(message.html.includes('Subscribe to see'));
    assert(!/Untitled role|undefined|\bnull\b|PRIVATE|source-job-|private\.example/i.test(message.html));
  }
  const invalid=[
    {...jobs[0],title_original:null}, {...jobs[1],title_original:'Untitled role'},
    {...jobs[2],company_name:'undefined'}, {...jobs[3],location_raw:'null'},
    {...jobs[4],title_original:'PRIVATEBRAND4'},
  ];
  const bad=await send([],invalid);
  assert.equal(bad.message,null);
  assert.deepEqual(bad.result,{sent:false,reason:'no_valid_alert_jobs'});
  const mixed=await send([], [jobs[0],...invalid.slice(1).map(j=>({...j,location_raw:'Orlando, FL',title_original:'Untitled role'}))]);
  assert.equal(mixed.result.jobCount,1);
  assert.equal(mixed.result.excludedJobCount,4);
  assert.match(mixed.message.subject,/^1 job waiting/);
  assert(mixed.message.html.includes('This role is'));
  assert(!mixed.message.html.includes('These 5'));
  const paid=await send([],jobs,{...profile,subscription_status:'active'});
  assert.equal(paid.result.jobCount,5);
  assert(paid.message.html.includes('PRIVATEBRAND0'));
  assert(paid.message.html.includes('/rook-job-analysis.html?job=source-job-0'));
  assert(!paid.message.html.includes('Subscribe to see'));
  for(const subscribed of [true,false]) {
    assert.equal(renderDigestHtml({jobs:[null,{},...jobs.map(j=>({...j,title_original:'placeholder'}))],appBaseUrl:base,subscribed}),null);
  }
  const normalized=prepareDigestJobs([{...jobs[0],title_original:null,title_normalized:'Account Executive'}],false);
  assert.equal(normalized[0].title_original,'Account Executive');
  const [safeLeak]=prepareDigestJobs([leakFixture],false);
  assert.equal(safeLeak.title_original,'Clinical Manager');
  assert.equal(safeLeak.location_raw,'Orlando, FL');
  assert.notEqual(safeLeak.title_original,'Untitled role');
  assert(!JSON.stringify(safeLeak).includes(leakedTitle));
  assert(!JSON.stringify(safeLeak).includes(leakFixture.company_name));
  assert(!JSON.stringify(safeLeak).includes(leakFixture.description_text));
  assert(!JSON.stringify(safeLeak).includes(leakFixture.source_url));
  const distinct=prepareDigestJobs([
    leakFixture,
    {...leakFixture,id:'territory-manager',title_original:'Territory Manager | Urology - Neuromodulation'},
    {...leakFixture,id:'account-executive',title_original:'Oncology Account Executive | Urology - Neuromodulation'},
  ],false).map(job=>job.title_original);
  assert.deepEqual(distinct,['Clinical Manager','Territory Manager','Oncology Account Executive']);
  const leakEmail=await send([],[leakFixture]);
  assert.equal(leakEmail.result.jobCount,1);
  assert(leakEmail.message.html.includes('Clinical Manager'));
  assert(leakEmail.message.html.includes('Orlando, FL'));
  for(const secret of [leakedTitle,leakFixture.company_name,leakFixture.description_text,leakFixture.source_url,'Untitled role']) {
    assert(!leakEmail.message.html.includes(secret),`${secret} must stay out of locked email`);
  }
  const paidLeak=await send([],[leakFixture],{...profile,subscription_status:'active'});
  assert(paidLeak.message.html.includes(leakedTitle));
  assert(paidLeak.message.html.includes(leakFixture.company_name));
  assert(paidLeak.message.html.includes('/rook-job-analysis.html?job=distinctive-title'));
  const escaped=await send([],[{...jobs[0],title_original:'Sales Representative <PRIVATE> & Account Manager',compensation_text:'null'}],{...profile,subscription_status:'active'});
  assert(escaped.message.html.includes('&lt;PRIVATE&gt; &amp;'));
  assert(!escaped.message.html.includes(' · null'));
  process.env.DAILY_JOB_ALERTS_PAUSED='true';
  const pausedDb=dbFor(jobs,[]),before=deliveries.length;
  assert.deepEqual(await sendDigestForCandidate(pausedDb.db,profile,base),{sent:false,reason:'daily_alerts_paused'});
  assert.equal(pausedDb.reads(),0);
  assert.equal(deliveries.length,before);
  delete process.env.DAILY_JOB_ALERTS_PAUSED;
  console.log('Daily alert display: reproduced all 5 Untitled rows; fresh/fallback, paid/free, invalid/mixed, normalization, escaping, privacy and pause checks passed (no network or real sends).');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
