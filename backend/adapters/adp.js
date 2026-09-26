// Public Workforce Now request contract verified against ADP's current careers
// application and official Aegis board. Legacy Recruiting is a separate API.
const { titleLooksRelevantWithDiagnostics: titleLooksRelevant } = require('../titleFilterDiagnostics');
const { plain } = require('./htmlSource');
const BASE = 'https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions';
const BOARD = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html';
async function json(url) {
  const r = await fetch(url, {signal: AbortSignal.timeout(15000), headers: {Accept:'application/json', 'X-Requested-With':'XMLHttpRequest'}});
  if (!r.ok) throw Error('ADP source HTTP ' + r.status);
  return r.json(); // HTML or unknown response must never become a healthy zero.
}
function normalizeAdpJob(raw, employer) {
  const reqId = raw.itemID;
  const externalId = raw.customFieldGroup?.stringFields?.find(f => f.nameCode?.codeValue === 'ExternalJobID')?.stringValue;
  if (!reqId || !externalId || !raw.requisitionTitle || !raw.requisitionDescription) throw Error('ADP detail missing stable ID, public job ID, title or description');
  const apply = new URL(BOARD);
  apply.search = new URLSearchParams({cid:employer.ats_identifier,ccId:'19000101_000001',lang:'en_US',jobId:externalId});
  const location = (raw.requisitionLocations || []).map(l => {
    const a = l.address || {};
    return l.nameCode?.shortName?.trim() || [a.cityName,a.countrySubdivisionLevel1?.codeValue,a.countryCode].filter(Boolean).join(', ');
  }).filter(Boolean).join(' | ');
  return {source_job_id:`adp-${employer.ats_identifier}-${reqId}`, source_type:'career_site',
    source_url:apply.href, application_url:apply.href, title_original:raw.requisitionTitle,
    company_name:employer.company_name, employer_id:employer.id, description_html:raw.requisitionDescription,
    description_text:plain(raw.requisitionDescription), location_raw:location,
    employment_type:raw.workLevelCode?.shortName || null, date_posted:raw.postDate?.slice(0,10) || null,
    status:'active', source_verified:true};
}
async function fetchAdpJobs(employer) {
  const cid = employer.ats_identifier || '';
  if (cid.startsWith('recruiting:')) throw Error('ADP legacy Recruiting extraction is unsupported; preserving existing jobs');
  if (!/^[a-f0-9-]{36}$/i.test(cid)) throw Error('Invalid verified ADP Workforce Now CID');
  const urlFor = suffix => {
    const u = new URL(BASE + suffix);
    u.search = new URLSearchParams({cid,ccId:'19000101_000001',lang:'en_US',locale:'en_US'});
    return u;
  };
  const listings = [], seen = new Set(), jobs = [];
  jobs.incompleteSnapshot = false; jobs.snapshotWarnings = [];
  for (let page = 0; ; page++) {
    try {
      if (page >= 100) throw Error('ADP pagination safety limit');
      const url = urlFor(''); url.searchParams.set('$skip', String(page*20)); url.searchParams.set('$top','20');
      const data = await json(url);
      if (!Array.isArray(data.jobRequisitions) || !Number.isInteger(data.meta?.totalNumber)) throw Error('ADP response missing jobRequisitions or total count');
      const batch = data.jobRequisitions;
      for (const row of batch) {
        if (!row.itemID || !row.requisitionTitle || seen.has(row.itemID)) throw Error('ADP malformed or repeated listing');
        seen.add(row.itemID); listings.push(row);
      }
      if (listings.length >= data.meta.totalNumber) break;
      if (!batch.length) throw Error('ADP pagination ended before total count');
    } catch(error) {
      if (!listings.length) throw error;
      jobs.incompleteSnapshot = true; jobs.snapshotWarnings.push(error.message); break;
    }
  }
  jobs.sourceListingCount = listings.length;
  for (const row of listings.filter(r => titleLooksRelevant(r.requisitionTitle, r))) {
    try {
      const detail = await json(urlFor('/'+encodeURIComponent(row.itemID)));
      if (detail.itemID !== row.itemID) throw Error('ADP detail identity mismatch');
      jobs.push(normalizeAdpJob(detail, employer));
    } catch(error) { jobs.incompleteSnapshot = true; jobs.snapshotWarnings.push(row.itemID+': '+error.message); }
  }
  return jobs;
}
module.exports = { fetchAdpJobs, normalizeAdpJob };
