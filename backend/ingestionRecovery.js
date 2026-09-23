// Recovery never changes source identity or deletes jobs. A failed source read
// before any writes can be retried once; partial writes wait for normal rotation.
async function recoverEmployer(employer, budgetMs, worker) {
  const started = Date.now();
  const first = await worker(employer, budgetMs);
  const attempts = [first];
  const metrics = { ...(first.metrics || {}) };
  const left = budgetMs - (Date.now() - started);
  const safeRetry = first.status === 'failed' && first.failure_stage === 'source' &&
    first.counts_complete !== false && !metrics.inserted && !metrics.updated && !metrics.closed;
  if (safeRetry && left >= 10000) {
    // Back off, within the original employer deadline, before retrying the same
    // verified source. No alternate source or employer identity is guessed.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const retry = await worker(employer, left - 1000);
    attempts.push(retry);
    for (const [key, count] of Object.entries(retry.metrics || {})) metrics[key] = (metrics[key] || 0) + count;
  }
  const last = attempts.at(-1);
  return { ...last, metrics, attempts, recovered: attempts.length > 1 && last.status === 'completed',
    counts_complete: attempts.every(a => a.counts_complete !== false) };
}
module.exports = { recoverEmployer };
