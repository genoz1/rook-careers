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
module.exports={project,broadRole};
