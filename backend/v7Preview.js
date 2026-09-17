// Only explicitly allowed values cross the anonymous boundary. Never spread
// a job or its AI analysis into an anonymous response.
const { scrubCompanyNameFromText } = require('./redaction');
const {classify} = require('../public/rook-job-classification');
const number = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
function safeText(value, job) {
  let text = String(value || '').replace(/<[^>]*>/g, ' ');
  for (const name of [job.company_name, job.recruiter_company, job.recruiter_name, job.source_type]) {
    text = scrubCompanyNameFromText(text, name);
  }
  return text.replace(/(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b[\w-]+\.(?:com|org|net|io|co|jobs)\b/gi, '[hidden]').slice(0, 180);
}
function preview(job, index) {
  return {
    id: `locked-${index}`, // Never disclose source identifiers or real job IDs.
    title_original: job.company_name ? safeText(job.title_original || job.title_normalized, job) : 'Medical sales opportunity',
    location_raw: safeText([job.city, job.state].filter(Boolean).join(', ') || (job.remote_status === 'remote' ? 'Remote' : ''), job),
    remote_status: job.remote_status === 'remote' ? 'remote' : 'field',
    distance_miles: number(job.distance_miles),
    salary_min: number(job.salary_min), salary_max: number(job.salary_max),
    date_posted: /^\d{4}-\d{2}-\d{2}/.test(job.date_posted || '') ? job.date_posted.slice(0,10) : null,
    subscription_required: true,
    industry_classification: classify(job),
    match: {
      overall_score: number(job.match?.overall_score),
      preference_fit: number(job.match?.preference_fit),
      candidate_fit: number(job.match?.candidate_fit),
      excellent_match: job.match?.excellent_match === true,
      recommendation: ['Strong Match','Apply','Stretch Apply','Skip'].includes(job.match?.recommendation) ? job.match.recommendation : null,
      reasons: [], concerns: []
    }
  };
}
function answersToProfile(a) {
  const l = a?.location;
  if (!l || typeof l.lat !== 'number' || typeof l.lng !== 'number' || !Number.isFinite(l.lat) || !Number.isFinite(l.lng) || Math.abs(l.lat)>90 || Math.abs(l.lng)>180) throw new Error('Select a valid location.');
  if (!['diagnostics','pharmaceutical','medical device','veterinary','breaking in'].includes(String(a.industry || '').toLowerCase())) throw new Error('Select an industry.');
  if (!Number.isFinite(a.years) || a.years < 0 || a.years > 60) throw new Error('Select your experience.');
  if (!Array.isArray(a.territories) || !a.territories.length || a.territories.length>4 || a.territories.some(t => !['local','regional','national','remote'].includes(t))) throw new Error('Select a territory.');
  const short = v => typeof v === 'string' ? v.slice(0,150) : null;
  const attribution = {};
  for (const key of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content']) {
    const value = a.attribution?.[key];
    if (typeof value === 'string' && value.trim()) attribution[key] = value.trim().slice(0,200);
  }
  return {
    ...attribution,
    home_lat:l.lat, home_lng:l.lng, home_city:short(l.city), home_state:short(l.state || l.stateAbbr), home_zip:short(l.zip), home_location_label:short(l.label),
    desired_industries:[a.industry], total_sales_years:a.years,
    territory_size_preferences:a.territories, territory_size_preference:a.territories[0],
    work_style:a.territories.length === 1 && a.territories[0] === 'remote' ? 'remote' : 'field'
  };
}
module.exports = {preview, answersToProfile};
