// V7 uses the shared V6 scorer, with a V7-only location validity boundary
// before ranking and the dashboard's 300-row display limit.
const {scoreJob} = require('./matching');
const {prepareJob} = require('./v7Location');
const {distanceMiles} = require('./geocoding');
const {matches, normalizeSelection} = require('../public/rook-job-classification');
const {readJobPool} = require('./jobPool');
const {industryPrefilter} = require('./industryPrefilter');
const JOB_LIST_COLUMNS = "id, source_job_id, employer_id, source_type, source_url, application_url, title_original, title_normalized, company_name, description_html, description_text, ai_analysis, location_raw, location_evidence, extraction_evidence, job_lat, job_lng, city, state, region, territory, remote_status, employment_type, category, subcategory, industry, product_type, sales_type, experience_min_years, experience_max_years, salary_min, salary_max, compensation_text, travel_percentage, overnight_travel, required_skills, preferred_skills, required_experience, preferred_experience, degree_required, certifications, date_posted, first_seen_at, last_seen_at, status, source_verified, moderation_status, recruiter_name, recruiter_email, recruiter_company, recruiter_contact_method, recruiter_id, created_at, updated_at";
const JOB_LIST_COLUMNS_NO_DESCRIPTION = JOB_LIST_COLUMNS.split(", ").filter((c) => c !== "description_html" && c !== "description_text").join(", ");

async function rank(db, profile, industrySelection = profile.desired_industries) {
    return rankPool(await readCandidates(db, industrySelection), profile, industrySelection);
}

async function readCandidates(db, industrySelection) {
    const selection = normalizeSelection(industrySelection);
    let query = db
      .from("jobs")
      .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
      .eq("status", "active")
      .eq("moderation_status", "approved");

    const marketFilter = industryPrefilter(selection);
    if (marketFilter) query = query.or(marketFilter);
    // Read every active approved industry candidate. Geographic preparation
    // must see secondary locations and source-backed scopes, including nulls.
    const {data: jobs,error} = await readJobPool(query);
    if (error) throw new Error(error.message);

    return jobs || [];
}

function rankPool(jobs, profile, industrySelection = profile.desired_industries) {
    const selection = normalizeSelection(industrySelection);
    // Search categories affect scoring only; geographic eligibility and saved answers stay intact.
    const scoringProfile = selection.length ? {...profile, desired_industries:selection} : profile;
    // Same tiebreaker as dashboard sort — industry match ratio + inside sales penalty
    function _anonProxyScore(job) {
      const ANON_INDUSTRY_TERMS = {
        diagnostics:      ['diagnostics','reference laboratory','molecular','point-of-care','lab','pathology','clinical laboratory'],
        pharmaceutical:   ['pharmaceutical','pharma','biotech','life sciences','specialty pharma'],
        'medical device': ['medical device','capital equipment','surgical','dme','consumables'],
        veterinary:       ['veterinary','animal health','vet'],
      };
      const title   = (job.title_original || '').toLowerCase();
      const empType = (job.employment_type || '').toLowerCase();
      const isInsideSales = title.includes('inside sales') || empType === 'inside';
      const wantsField = (profile.territory_size_preferences || []).some(t => ['local','regional'].includes(t)) &&
        !(profile.territory_size_preferences || []).includes('remote');
      if (isInsideSales && wantsField) return -0.1;
      const prodCats = (job.ai_analysis?.product_categories || []).map(s => s.toLowerCase());
      const desired = scoringProfile.desired_industries || [];
      const terms = desired.flatMap(ind => (ANON_INDUSTRY_TERMS[ind.toLowerCase().trim()] || [ind.toLowerCase()]));
      const matched = prodCats.filter(p => terms.some(t => p.includes(t))).length;
      // Keep established product-ratio ties; Veterinary market/customer-only matches
      // must not be treated as zero industry evidence.
      return matched ? matched / prodCats.length : (normalizeSelection(desired).includes("Veterinary") && matches(job, ["Veterinary"]) ? 1 : 0);
    }


    const scored = (jobs || [])
      .map(j => prepareJob(j,profile))
      .filter(Boolean)
      .filter(j => !selection.length || matches(j, selection))
      .map(j => {
        const distMi = j.job_lat != null
          ? Math.round(distanceMiles(profile.home_lat, profile.home_lng, j.job_lat, j.job_lng))
          : null;
        return { job: j, score: scoreJob(j, scoringProfile, {geography:j.geographic_eligibility, smoothLocalDistance:true, canonicalVeterinaryEvidence:true}), distMi, proxy: _anonProxyScore(j) };
      })
      .filter(r => r.score.overall_score >= 50)
      .sort((a, b) => {
        const sc = b.score.overall_score - a.score.overall_score;
        if (sc !== 0) return sc;
        const rc = b.proxy - a.proxy;
        if (Math.abs(rc) > 0.01) return rc;
        const ad = a.distMi ?? 9999, bd = b.distMi ?? 9999;
        return ad - bd || String(a.job.id).localeCompare(String(b.job.id));
      })
      .slice(0, 300);

return scored.map(({job,score,distMi}) => ({...job, match:score, distance_miles:distMi}));
}
module.exports = {rank, readCandidates, rankPool};
