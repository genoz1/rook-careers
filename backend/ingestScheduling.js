// Fair scheduling helpers for scheduled employer ingestion.
// Kept free of Supabase/adapter imports so unit tests can exercise them
// without booting the full ingest worker graph.

const TIME_BUDGET_MS = 25 * 60 * 1000; // 25 min — 5 min buffer under DO's 30-min hard limit
const NEVER_CHECKED_RESERVE_MS = 8 * 60 * 1000;
const EXPENSIVE_ATS = new Set(['workday', 'icims', 'successfactors', 'oraclehcm', 'phenom', 'adp']);

function orderEmployersForIngest(employers = []) {
  const never = [];
  const held = [];
  const rest = [];
  for (const employer of employers) {
    if (!employer.last_checked_at) never.push(employer);
    else if (employer.ingestion_hold_reason) held.push(employer);
    else rest.push(employer);
  }
  rest.sort((a, b) => new Date(a.last_checked_at) - new Date(b.last_checked_at));
  held.sort((a, b) => new Date(a.last_checked_at || 0) - new Date(b.last_checked_at || 0));
  // Never-checked first, then oldest remotes, held skips last.
  return [...never, ...rest, ...held];
}

function employerTimeBudgetMs(employer, remainingMs, { neverSyncedRemaining = 0, elapsedMs = 0 } = {}) {
  const expensive = EXPENSIVE_ATS.has(String(employer?.ats_type || '').toLowerCase());
  const neverChecked = !employer?.last_checked_at;
  const backlogPressure = neverSyncedRemaining > 0 && elapsedMs < NEVER_CHECKED_RESERVE_MS;
  if (employer?.ingestion_hold_reason) return Math.min(15_000, Math.max(1_000, remainingMs - 3_000));
  if (neverChecked) {
    const cap = expensive ? (backlogPressure ? 90_000 : 150_000) : 120_000;
    return Math.min(cap, Math.max(5_000, remainingMs - 3_000));
  }
  const cap = expensive ? (backlogPressure ? 90_000 : 150_000) : 180_000;
  return Math.min(cap, Math.max(5_000, remainingMs - 3_000));
}

module.exports = {
  TIME_BUDGET_MS,
  NEVER_CHECKED_RESERVE_MS,
  EXPENSIVE_ATS,
  orderEmployersForIngest,
  employerTimeBudgetMs,
};
