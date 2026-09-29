// Read-only reporting. This module never emits or changes analytics events.
const { createSign } = require('node:crypto');
const { calendarRange } = require('./reportingPeriod');
const STAGES = [
  ['V8 landings', 'v8_dashboard_impression'],
  ['V8 search starts', 'v8_show_my_jobs_requested'],
  ['Signup reached', 'v8_signup_started'],
  ['Account created', 'v8_account_created'],
  ['Checkout started', 'v8_checkout_started'],
  ['Trial activated', 'v8_trial_started'],
];
const EVENTS = [...STAGES.map(s => s[1]), 'sign_up'];
class ReportingError extends Error {}
function createReporter({ env = process.env, fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const cache = new Map();
  let token, tokenUntil = 0;
  async function json(url, options) {
    const r = await fetcher(url, { ...options, signal: AbortSignal.timeout(12000) });
    if (!r.ok) {
      // Never return raw provider responses (which can contain credential details).
      if (r.status === 401 || r.status === 403) throw new ReportingError('GA4 access denied. Check service-account Viewer access and that the Analytics Data API is enabled.');
      throw new ReportingError(`GA4 request failed (${r.status}). Please retry later.`);
    }
    return r.json();
  }
  async function accessToken() {
    if (token && tokenUntil > now()) return token;
    let account;
    try { account = JSON.parse(env.GA4_SERVICE_ACCOUNT_JSON); } catch { throw new ReportingError('GA4_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
    if (!account.client_email || !account.private_key) throw new ReportingError('GA4 service account requires client_email and private_key.');
    const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const iat = Math.floor(now() / 1000);
    const unsigned = b64({ alg:'RS256', typ:'JWT' }) + '.' + b64({ iss:account.client_email, scope:'https://www.googleapis.com/auth/analytics.readonly', aud:'https://oauth2.googleapis.com/token', iat, exp:iat+3600 });
    let signature;
    try { signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url'); } catch { throw new ReportingError('GA4 service-account private key is invalid.'); }
    const data = await json('https://oauth2.googleapis.com/token', { method:'POST', body:new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:unsigned+'.'+signature }) });
    if (!data.access_token) throw new ReportingError('GA4 authentication did not return an access token.');
    token = data.access_token; tokenUntil = now() + Math.max(0, (Number(data.expires_in || 3600)-60)*1000);
    return token;
  }
  async function run(period) {
    if (!/^\d+$/.test(env.GA4_PROPERTY_ID || '') || !env.GA4_SERVICE_ACCOUNT_JSON) return { ok:false, error:'GA4 setup required: set numeric GA4_PROPERTY_ID and GA4_SERVICE_ACCOUNT_JSON on the server. Grant the service account Viewer access to the property.' };
    const bearer = await accessToken();
    const dateRanges = [{ startDate:period==='7d'?'6daysAgo':period, endDate:period==='yesterday'?'yesterday':'today' }];
    const report = (dimensions, metrics, extra={}) => ({ dateRanges, dimensions:dimensions.map(name=>({name})), metrics:metrics.map(name=>({name})), ...extra });
    const eventFilter = { filter:{ fieldName:'eventName', inListFilter:{values:EVENTS} } };
    const reports = [
      report([], ['totalUsers','sessions','newUsers']),
      report(['eventName'], ['eventCount','totalUsers'], {dimensionFilter:eventFilter,limit:100}),
      report(['sessionSourceMedium','sessionCampaignName'], ['sessions','totalUsers'], {limit:100,orderBys:[{metric:{metricName:'sessions'},desc:true}]}),
      report(['sessionSourceMedium','sessionCampaignName','eventName'], ['eventCount'], {dimensionFilter:eventFilter,limit:1000,orderBys:[{metric:{metricName:'eventCount'},desc:true}]})
    ];
    const data = await json(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA4_PROPERTY_ID}:batchRunReports`, {method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({requests:reports})});
    if (data.reports?.length !== 4) throw new ReportingError('GA4 returned an incomplete report.');
    const [totals, events, traffic, attributed] = data.reports;
    const values = row => (row?.metricValues || []).map(v=>Number(v.value));
    const eventRows = Object.fromEntries((events.rows || []).map(r=>[r.dimensionValues[0].value,{count:values(r)[0],users:values(r)[1]}]));
    const warnings = ['GA4 sign_up may contain duplicate events; source investigation is still pending.'];
    if (data.reports.some(r=>r.metadata?.subjectToThresholding)) warnings.push('GA4 privacy thresholds may suppress data.');
    if (data.reports.some(r=>r.metadata?.dataLossFromOtherRow)) warnings.push('GA4 grouped some high-cardinality data into (other).');
    if (data.reports.some(r=>r.metadata?.samplingMetadatas?.length)) warnings.push('GA4 returned sampled data.');
    if ((traffic.rowCount || 0)>100 || (attributed.rowCount || 0)>1000) warnings.push('Attribution lists show the top rows only, not complete totals.');
    const tz=totals.metadata?.timeZone;
    return {ok:true,period,property_id:env.GA4_PROPERTY_ID,time_zone:tz || 'Unknown',range:tz?calendarRange(period,tz,new Date(now())):null,fetched_at:new Date(now()).toISOString(),
      totals:{users:values(totals.rows?.[0])[0] || 0,sessions:values(totals.rows?.[0])[1] || 0,new_users:values(totals.rows?.[0])[2] || 0},
      stages:STAGES.map(([label,event])=>({label,event,...(eventRows[event] || {count:null,users:null})})),sign_up:eventRows.sign_up?.count ?? null,
      traffic:(traffic.rows || []).map(r=>({source_medium:r.dimensionValues[0].value,campaign:r.dimensionValues[1].value,sessions:values(r)[0],users:values(r)[1]})),
      attributed_events:(attributed.rows || []).map(r=>({source_medium:r.dimensionValues[0].value,campaign:r.dimensionValues[1].value,event:r.dimensionValues[2].value,count:values(r)[0]})),warnings};
  }
  return async function getReport(period='today') {
    if (!['today','yesterday','7d'].includes(period)) throw new ReportingError('Invalid reporting period');
    const existing=cache.get(period);
    if (existing && existing.until>now()) return existing.promise;
    const promise=run(period).catch(e=>({ok:false,error:e.name==='TimeoutError'?'GA4 request timed out. Please retry.':e instanceof ReportingError?e.message:'GA4 reporting unavailable. Check server configuration and connectivity, then retry.'}));
    cache.set(period,{until:now()+60000,promise});
    return promise;
  };
}
module.exports = { createReporter, getReport:createReporter(), STAGES };
