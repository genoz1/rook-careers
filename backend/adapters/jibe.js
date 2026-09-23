const { getHtml } = require('./htmlSource');
async function fetchJibeJobs(host) {
  const home = await getHtml('https://' + host + '/jobs');
  if (!/window\._jibe\s*=/.test(home)) throw new Error('Not a verified Jibe careers board');
  const rows = [], ids = new Set();
  let total = Infinity;
  for (let page = 1; rows.length < total && page <= 100; page++) {
    const res = await fetch('https://' + host + '/api/jobs?page=' + page + '&limit=100', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('Jibe listing HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.jobs) || !Number.isInteger(data.totalCount)) throw new Error('Jibe listing schema mismatch');
    total = data.totalCount; let added = 0;
    for (const item of data.jobs) {
      const job = item.data;
      if (!job?.req_id || !job.title || !job.description) throw new Error('Jibe job lacks identity or complete detail');
      if (!ids.has(String(job.req_id))) { ids.add(String(job.req_id)); rows.push({ ...job, canonical_url: 'https://' + host + '/jobs/' + encodeURIComponent(job.slug || job.req_id) + '?lang=' + encodeURIComponent(job.language || 'en-us') }); added++; }
    }
    if (!added && rows.length < total) { rows.incompleteSnapshot = true; break; }
  }
  if (rows.length < total) rows.incompleteSnapshot = true;
  return rows;
}
module.exports = { fetchJibeJobs };
