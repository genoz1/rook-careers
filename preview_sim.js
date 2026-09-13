require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');
const { scoreJob, mentionsNonUsCountry } = require('./backend/matching');
const { distanceMiles, geocodeZip } = require('./backend/geocoding');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const JOB_LIST_COLUMNS_NO_DESCRIPTION = "id, title_original, company_name, location_raw, job_lat, job_lng, city, state, industry, remote_status, employment_type, travel_percentage, salary_min, salary_max, compensation_text, ai_analysis, date_posted, first_seen_at, last_seen_at";

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

const _INDUSTRY_TERMS = {
  diagnostics: ['diagnostics','reference laboratory','molecular','point-of-care','lab','pathology','clinical laboratory'],
  pharmaceutical: ['pharmaceutical','pharma','biotech','life sciences','specialty pharma'],
  'medical device': ['medical device','capital equipment','surgical','dme','consumables'],
  veterinary: ['veterinary','animal health','vet'],
};

function proxyScore(job, profile) {
  const title = (job.title_original||'').toLowerCase();
  const empType = (job.employment_type||'').toLowerCase();
  const isInsideSales = title.includes('inside sales') || empType === 'inside';
  const wantsField = (profile.territory_size_preferences||[]).some(t=>['local','regional'].includes(t)) &&
    !(profile.territory_size_preferences||[]).includes('remote');
  if (isInsideSales && wantsField) return -0.1;
  const prodCats = (job.ai_analysis?.product_categories||[]).map(s=>s.toLowerCase());
  if (!prodCats.length) return 0;
  const desired = profile.desired_industries||[];
  const terms = desired.flatMap(ind=>(_INDUSTRY_TERMS[ind.toLowerCase().trim()]||[ind.toLowerCase()]));
  const matched = prodCats.filter(p=>terms.some(t=>p.includes(t))).length;
  return matched/prodCats.length;
}

function badCoords(job) {
  if (!job.job_lat || !job.state) return false;
  const s = job.state.toUpperCase().trim();
  if (!STATE_CENTERS[s]) return false;
  const [sLat, sLng] = STATE_CENTERS[s];
  return distanceMiles(job.job_lat, job.job_lng, sLat, sLng) > 400;
}

async function run() {
  const profile = {
    home_lat: 28.93, home_lng: -82.04, home_state: 'Florida',
    desired_industries: ['Diagnostics'],
    total_sales_years: 10,
    territory_size_preferences: ['local'],
    territory_size_preference: 'local',
  };

  const latDelta = 300/69;
  const lngDelta = 300/(69*Math.max(0.1,Math.cos(profile.home_lat*Math.PI/180)));

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
    .eq('status','active')
    .eq('moderation_status','approved')
    .or(`job_lat.is.null,remote_status.eq.remote,and(job_lat.gte.${profile.home_lat-latDelta},job_lat.lte.${profile.home_lat+latDelta},job_lng.gte.${profile.home_lng-lngDelta},job_lng.lte.${profile.home_lng+lngDelta})`)
    .limit(400);

  if (error) { console.error('DB error:', error.message); return; }

  const scored = (jobs||[])
    .filter(j=>!mentionsNonUsCountry(j.location_raw, j.job_lng, j.title_original))
    .map(j => {
      const bad = badCoords(j);
      const dist = j.job_lat ? Math.round(distanceMiles(profile.home_lat, profile.home_lng, j.job_lat, j.job_lng)) : null;
      const s = scoreJob(j, profile);
      const proxy = proxyScore(j, profile);
      return { title:j.title_original, company:j.company_name, location:j.location_raw, state:j.state, dist, score:Math.round(s.overall_score), proxy, bad };
    })
    .filter(r=>r.score>=50)
    .sort((a,b)=>{
      const sc=b.score-a.score; if(sc!==0) return sc;
      const rc=b.proxy-a.proxy; if(Math.abs(rc)>0.01) return rc;
      return (a.dist??9999)-(b.dist??9999);
    });

  const badCount = scored.filter(j=>j.bad).length;
  console.log(`\nTotal jobs scored: ${scored.length} (${badCount} have bad coordinates)\n`);

  console.log('=== DASHBOARD — current order (top 20) ===\n');
  scored.slice(0,20).forEach((j,i)=>{
    const flag = j.bad ? ' ⚠️  BAD COORDS' : '';
    const dist = j.dist!=null ? j.dist+'mi' : 'no coords';
    console.log(`${i+1}. ${j.score}%  ${dist.padEnd(10)} ${(j.company||'').slice(0,25).padEnd(26)} ${(j.title||'').slice(0,50)}${flag}`);
  });

  console.log('\n=== V6 PREVIEW — top 3 ===\n');
  scored.slice(0,3).forEach((j,i)=>{
    const flag = j.bad ? ' ⚠️  BAD COORDS' : '';
    console.log(`${i+1}. ${j.score}%  ${j.title}${flag}`);
  });

  if (badCount > 0) {
    console.log(`\n=== JOBS WITH BAD COORDINATES (${badCount} total) ===\n`);
    scored.filter(j=>j.bad).forEach(j=>{
      console.log(`  ⚠️  ${j.company} — ${j.title}`);
      console.log(`     location_raw: ${j.location_raw}`);
      console.log(`     state: ${j.state}, stored dist from you: ${j.dist}mi`);
    });
  }
}

run().catch(console.error);
