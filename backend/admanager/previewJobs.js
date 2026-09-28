const crypto = require('node:crypto');

// The live seven-day platform reports can outlast the HTTP gateway deadline.
// Start them outside the request and let the page poll for the result.
const jobs = new Map();
const CACHE_MS = 60_000;
const MAX_JOBS = 20;

function getOrStart(key, work) {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.expiresAt < now) jobs.delete(id);
  for (const job of jobs.values()) if (job.key === key) return job;
  if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);
  const job = { id:crypto.randomUUID(), key, state:'pending', expiresAt:now + CACHE_MS };
  jobs.set(job.id, job);
  Promise.resolve().then(work).then(
    result => { job.state='complete'; job.result=result; job.expiresAt=Date.now() + (result.status === 200 ? CACHE_MS : 5_000); },
    error => { job.state='complete'; job.result={ status:502, body:{ error:`Preview reporting failed: ${error.message}` } }; job.expiresAt=Date.now() + 5_000; }
  );
  return job;
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job || job.expiresAt < Date.now()) { jobs.delete(id); return null; }
  return job;
}

module.exports = { getOrStart, getJob };
