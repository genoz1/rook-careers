// Only this allowlist may cross the locked job boundary. Source records and
// matching remain unchanged; no title, excerpt or free-form AI text is copied.
const {classify} = require('../public/rook-job-classification');
const {freshness} = require('./maskedPresentation');
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const score = value => number(value) == null ? null : Math.max(0, Math.min(100, value));
function broadRole(job) {
  const roles = {account_management:'Account Management', 'account management':'Account Management',
    'field sales':'Field Sales', 'territory sales':'Field Sales', 'inside sales':'Inside Sales',
    'sales leadership':'Sales Leadership', 'business development':'Business Development'};
  for (const value of [job.sales_type,job.category,job.subcategory]) {
    const role=roles[String(value || '').trim().toLowerCase()];
    if(role) return role;
  }
  return null;
}
function project(job, index=0) {
  const territory = {regional:'Regional Territory',national:'National Territory',remote:'Remote / Territory Role'};
  return {
    id:`locked-${Number.isInteger(index) && index>=0 ? index : 0}`,
    subscription_required:true,
    industry_classification:classify(job),
    role_type:broadRole(job),
    distance_miles:number(job.distance_miles) == null || job.distance_miles<0 ? null : Math.round(job.distance_miles),
    territory_type:job.remote_status === 'remote' ? territory.remote : territory[String(job.territory || '').toLowerCase()] || null,
    freshness_label:freshness(job),
    match:{overall_score:score(job.match?.overall_score),preference_fit:score(job.match?.preference_fit),
      candidate_fit:score(job.match?.candidate_fit),excellent_match:job.match?.excellent_match===true,
      recommendation:['Strong Match','Apply','Stretch Apply','Skip'].includes(job.match?.recommendation) ? job.match.recommendation : null,
      reasons:[],concerns:[]}
  };
}
// Public deep links use the same classification and title vocabulary boundary.
// Never copy descriptions, AI prose, employer identifiers or source URLs.
function publicPreview(job) {
  const safe = project(job);
  const zipcodes = require('zipcodes');
  const raw = String(job.location_raw || '').split(',').map(s => s.trim());
  const cityInput = String(job.city || raw[0] || '').trim();
  const city = /^new york city$/i.test(cityInput) ? 'New York' : cityInput;
  const stateValue = String(job.state || raw[1] || '').trim().toUpperCase();
  const state = stateValue.length === 2 ? stateValue : zipcodes.states.full[stateValue];
  const place = Object.values(zipcodes.codes).find(p => p.city.toLowerCase() === city.toLowerCase() && p.state === state);
  const location = place ? `${place.city}, ${place.state}` : null;
  // Only validated geography may augment the shared title vocabulary.
  const title = require('./maskedPresentation').maskedTitle({...job, city:place?.city || '', state:place?.state || '', location_raw:location || ''});
  const employment = {'full-time':'Full-time','full time':'Full-time','part-time':'Part-time','part time':'Part-time',contract:'Contract',temporary:'Temporary',internship:'Internship','per diem':'Per diem'}[String(job.employment_type || '').toLowerCase()] || null;
  let min = number(job.salary_min), max = number(job.salary_max);
  if (min == null && max == null) {
    // Accept only a complete numeric USD range, never free-form compensation.
    const range = String(job.compensation_text || '').match(/^\s*\$?([\d,]+(?:\.\d{1,2})?)\s*[–—-]\s*\$?([\d,]+(?:\.\d{1,2})?)\s*(?:USD)?\s*$/i);
    if (range) { min = Number(range[1].replace(/,/g,'')); max = Number(range[2].replace(/,/g,'')); }
  }
  const money = n => n != null && n > 0 && n < 10000000 ? '$' + n.toLocaleString('en-US') : null;
  const salary = [money(min),money(max)].filter(Boolean).join('–') || null;
  const category = safe.industry_classification.labels.join(' · ');
  const summary = `${title}${location ? ' in ' + location : ''}${category ? '. Industry: ' + category : ''}. Explore this opportunity and unlock the complete job description with your free trial.`;
  return {...safe,title,location,employment_type:employment,salary,summary};
}
module.exports={project,broadRole,publicPreview};
