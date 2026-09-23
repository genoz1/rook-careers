// UKG public JobBoard contract verified from the board's own rendered config
// and browser bundle. No applicant login or candidate data is used.
const { titleLooksRelevant } = require('../relevanceFilter');
const { getHtml, plain } = require('./htmlSource');
function detailData(html) {
  const marker = 'new US.Opportunity.CandidateOpportunityDetail(';
  const start = html.indexOf(marker);
  if (start < 0) throw Error('UKG detail schema missing');
  const tail = html.slice(start + marker.length);
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(tail.slice(0, i + 1));
  }
  throw Error('UKG detail JSON incomplete');
}
function normalizeUkgJob(raw, employer, url) {
  const location = (raw.Locations || []).map(l => {
    const a = l.Address || {};
    return [a.City, a.State?.Code, a.Country?.Name].filter(Boolean).join(', ');
  }).filter(Boolean).join(' | ');
  if (!raw.Id || !raw.Title || !raw.Description) throw Error('UKG detail missing identity, title or description');
  return { source_job_id: `ukg-${employer.ats_identifier.split('|')[2]}-${raw.Id}`,
    source_type: 'career_site', source_url: url, application_url: url,
    title_original: raw.Title, company_name: employer.company_name, employer_id: employer.id,
    description_html: raw.Description, description_text: plain(raw.Description), location_raw: location,
    employment_type: raw.FullTime ? 'Full Time' : null,
    date_posted: raw.PostedDate || null, status: 'active', source_verified: true };
}
async function fetchUkgJobs(employer) {
  const [host, org, board] = String(employer.ats_identifier || '').split('|');
  if (!/^recruiting\d*\.ultipro\.com$/.test(host) || !/^[a-z0-9]+$/i.test(org) || !/^[a-f0-9-]+$/i.test(board)) throw Error('Invalid verified UKG board configuration');
  const base = `https://${host}/${org}/JobBoard/${board}`;
  const html = await getHtml(base);
  const loadPath = html.match(/loadUrl:\s*"([^"]+)"/)?.[1];
  const detailPath = html.match(/opportunityLinkUrl:\s*"([^"]+)"/)?.[1];
  if (!loadPath || !detailPath) throw Error('UKG public board no longer exposes its search/detail contract');
  const load = new URL(loadPath, base), template = new URL(detailPath, base);
  if ([load, template].some(u => u.origin !== new URL(base).origin || !u.pathname.startsWith(`/${org}/JobBoard/${board}/`))) throw Error('UKG board identity mismatch');
  const all = [], ids = new Set(), jobs = []; let total = null;
  jobs.incompleteSnapshot = false; jobs.snapshotWarnings = [];
  for (let page = 0; page < 100; page++) {
    try {
      const res = await fetch(load.href, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ opportunitySearch: { Top: 50, Skip: page * 50, QueryString: '', Filters: [], OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }] } }) });
      if (!res.ok) throw Error('UKG listing HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data.opportunities) || !Number.isInteger(data.totalCount)) throw Error('UKG listing schema invalid');
      total = data.totalCount; let added = 0;
      for (const row of data.opportunities) {
        if (!row.Id || !row.Title) throw Error('UKG listing identity missing');
        if (!ids.has(row.Id)) { ids.add(row.Id); all.push(row); added++; }
      }
      if (all.length >= total) break;
      if (!added || page === 99) throw Error('UKG pagination incomplete');
    } catch (error) {
      if (!all.length) throw error;
      jobs.incompleteSnapshot = true; jobs.snapshotWarnings.push(error.message); break;
    }
  }
  jobs.sourceListingCount = all.length;
  for (const row of all.filter(j => titleLooksRelevant(j.Title))) {
    try {
      const url = new URL(template); url.searchParams.set('opportunityId', row.Id);
      const detail = detailData(await getHtml(url.href));
      if (detail.Id !== row.Id) throw Error('UKG detail identity mismatch');
      jobs.push(normalizeUkgJob(detail, employer, url.href));
    } catch (error) { jobs.incompleteSnapshot = true; jobs.snapshotWarnings.push('Detail ' + row.Id + ': ' + error.message); }
  }
  return jobs;
}
module.exports = { fetchUkgJobs, normalizeUkgJob, detailData };
