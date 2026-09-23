const { fork } = require('node:child_process');
const path = require('node:path');
function boundedEmployer(employer, timeoutMs, { worker = path.join(__dirname, 'ingestEmployerWorker.js'), onProgress = () => {}, repairSourceOnly = false, disableClosures = false } = {}) {
  return new Promise(resolve => {
    let metrics = {}, outcome = null, timedOut = false;
    const child = fork(worker, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env,
      ROOK_INGEST_REPAIR_SOURCE_ONLY: repairSourceOnly ? '1' : '0', ROOK_INGEST_REPAIR_NO_CLOSURES: disableClosures ? '1' : '0' } });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(1, timeoutMs));
    child.on('message', message => {
      if (message.metrics) { metrics = message.metrics; onProgress(metrics); }
      if (message.type === 'done' || message.type === 'failed') outcome = message;
    });
    child.once('error', error => { outcome = { type: 'failed', error: error.message }; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve(timedOut ? { status: 'timeout', metrics, error: 'Employer deadline exceeded', counts_complete: false } :
        outcome?.type === 'done' ? { ...outcome.result, status: outcome.result?.status || 'completed', metrics, counts_complete: true } :
        { status: 'failed', metrics, counts_complete: false, error: outcome?.error || 'Worker exited '+code+'/'+signal });
    });
    child.send(employer);
  });
}
module.exports = { boundedEmployer };
