// V7 uses the shared V6 scorer, with a V7-only location validity boundary
// before ranking and the dashboard's 300-row display limit.
const {scoreJob} = require('./matching');
const {prepareJob} = require('./v7Location');
const {distanceMiles} = require('./geocoding');
const JOB_LIST_COLUMNS = "id, source_job_id, employer_id, source_type, source_url, application_url, title_original, title_normalized, company_name, description_html, description_text, ai_analysis, location_raw, job_lat, job_lng, city, state, region, territory, remote_status, employment_type, category, subcategory, industry, product_type, sales_type, experience_min_years, experience_max_years, salary_min, salary_max, compensation_text, travel_percentage, overnight_travel, required_skills, preferred_skills, required_experience, preferred_experience, degree_required, certifications, date_posted, first_seen_at, last_seen_at, status, source_verified, moderation_status, recruiter_name, recruiter_email, recruiter_company, recruiter_contact_method, recruiter_id, created_at, updated_at";
const JOB_LIST_COLUMNS_NO_DESCRIPTION = JOB_LIST_COLUMNS.split(", ").filter((c) => c !== "description_html" && c !== "description_text").join(", ");

async function rank(db, profile) {
    // Same geographic query shape and 1,000-row pool as the dashboard.
    const latDelta = 300 / 69;
    const lngDelta = 300 / (69 * Math.max(0.1, Math.cos((profile.home_lat * Math.PI) / 180)));

    const { data: jobs, error } = await db
      .from("jobs")
      .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .or(`job_lat.is.null,remote_status.eq.remote,and(job_lat.gte.${profile.home_lat - latDelta},job_lat.lte.${profile.home_lat + latDelta},job_lng.gte.${profile.home_lng - lngDelta},job_lng.lte.${profile.home_lng + lngDelta})`)
      .limit(1000);

    if (error) throw new Error(error.message);

    // Word-for-word copy of dashboard titleLocSanityPass — plus state-center check
    const TITLE_LOC_CHECKS = {
      'south florida': { lat: 25.9, lng: -80.3 },
      'miami':         { lat: 25.77, lng: -80.19 },
      'fort lauderdale': { lat: 26.12, lng: -80.14 },
      'palm beach':    { lat: 26.71, lng: -80.05 },
      'pensacola':     { lat: 30.42, lng: -87.22 },
      'tallahassee':   { lat: 30.44, lng: -84.28 },
      'jacksonville':  { lat: 30.33, lng: -81.66 },
    };
    // Approximate geographic center of each US state.
    // Used to detect jobs whose stored coordinates are in the wrong state.
    const STATE_CENTERS = {
      AL:[32.7,-86.7],AK:[64.2,-153.4],AZ:[34.3,-111.1],AR:[34.9,-92.4],
      CA:[37.2,-119.4],CO:[39.0,-105.5],CT:[41.6,-72.7],DE:[39.1,-75.5],
      FL:[28.7,-82.5],GA:[32.7,-83.2],HI:[20.3,-156.4],ID:[44.4,-114.6],
      IL:[40.0,-89.2],IN:[40.3,-86.1],IA:[42.0,-93.5],KS:[38.5,-98.4],
      KY:[37.5,-85.3],LA:[31.0,-91.8],ME:[44.7,-69.4],MD:[39.1,-76.8],
      MA:[42.2,-71.5],MI:[44.2,-85.5],MN:[46.4,-93.1],MS:[32.7,-89.7],
      MO:[38.4,-92.5],MT:[46.9,-110.4],NE:[41.5,-99.9],NV:[39.3,-116.6],
      NH:[43.7,-71.6],NJ:[40.1,-74.5],NM:[34.3,-106.1],NY:[42.9,-75.6],
      NC:[35.6,-79.4],ND:[47.5,-100.5],OH:[40.4,-82.8],OK:[35.6,-97.5],
      OR:[44.6,-120.5],PA:[40.6,-77.2],RI:[41.7,-71.5],SC:[33.9,-80.9],
      SD:[44.4,-100.3],TN:[35.9,-86.7],TX:[31.1,-100.1],UT:[39.4,-111.1],
      VT:[44.1,-72.7],VA:[37.5,-78.5],WA:[47.4,-120.5],WV:[38.6,-80.6],
      WI:[44.3,-89.8],WY:[42.8,-107.6],DC:[38.9,-77.0],
    };
    function titleLocSanityPass(job) {
      if (!job.job_lat || !profile?.home_lat) return true;
      const title = (job.title_original || '').toLowerCase();
      const computedDist = distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng);
      // City-based check (existing)
      for (const [kw, coords] of Object.entries(TITLE_LOC_CHECKS)) {
        if (title.includes(kw)) {
          const actual = distanceMiles(profile.home_lat, profile.home_lng, coords.lat, coords.lng);
          if (Math.abs(actual - computedDist) > 80) return false;
        }
      }
      // State-based check: if stored coordinates are > 400 miles from the job's
      // stated state center, the coordinates are wrong (e.g. Denver job stored
      // near Boston). Catches bad data for any state, not just Florida cities.
      const jobState = (job.state || '').toUpperCase().trim();
      if (jobState && STATE_CENTERS[jobState]) {
        const [sLat, sLng] = STATE_CENTERS[jobState];
        const distFromState = distanceMiles(job.job_lat, job.job_lng, sLat, sLng);
        if (distFromState > 400) return false;
      }
      return true;
    }

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
      if (!prodCats.length) return 0;
      const desired = profile.desired_industries || [];
      const terms = desired.flatMap(ind => (ANON_INDUSTRY_TERMS[ind.toLowerCase().trim()] || [ind.toLowerCase()]));
      const matched = prodCats.filter(p => terms.some(t => p.includes(t))).length;
      return matched / prodCats.length;
    }

    const scored = (jobs || [])
      .map(j => prepareJob(j,profile))
      .filter(Boolean)
      .filter(j => titleLocSanityPass(j))
      .map(j => {
        const distMi = j.job_lat != null
          ? Math.round(distanceMiles(profile.home_lat, profile.home_lng, j.job_lat, j.job_lng))
          : null;
        return { job: j, score: scoreJob(j, profile), distMi, proxy: _anonProxyScore(j) };
      })
      .filter(r => r.score.overall_score >= 50)
      .sort((a, b) => {
        const sc = b.score.overall_score - a.score.overall_score;
        if (sc !== 0) return sc;
        const rc = b.proxy - a.proxy;
        if (Math.abs(rc) > 0.01) return rc;
        const ad = a.distMi ?? 9999, bd = b.distMi ?? 9999;
        return ad - bd;
      })
      .slice(0, 300);

return scored.map(({job,score,distMi}) => ({...job, match:score, distance_miles:distMi}));
}
module.exports = {rank};
