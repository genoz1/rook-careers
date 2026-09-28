const assert = require('node:assert/strict');
const { getOrStart, getJob } = require('./previewJobs');

(async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const job = getOrStart('budget-2000', () => pending);
  assert.equal(job.state, 'pending');
  assert.equal(getOrStart('budget-2000', () => { throw new Error('duplicate work'); }).id, job.id);
  complete({ status:200, body:{ preview:{ ok:true } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getJob(job.id).state, 'complete');
  assert.equal(getJob(job.id).result.body.preview.ok, true);
  const failed = getOrStart('budget-3000', () => { throw new Error('platform down'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getJob(failed.id).result.status, 502);
  assert.match(getJob(failed.id).result.body.error, /platform down/);
  console.log('Ad Manager preview job tests passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
