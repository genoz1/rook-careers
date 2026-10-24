// Fair scheduling helpers for scheduled employer ingestion.
// Kept free of Supabase/adapter imports so unit tests can exercise them
// without booting the full ingest worker graph.

const TIME_BUDGET_MS = 25 * 60 * 1000; // 25 min — 5 min buffer under DO's 30-min hard limit
const NEVER_CHECKED_RESERVE_MS = 8 * 60 * 1000;
const EXPENSIVE_ATS = new Set(['workday', 'icims', 'successfactors', 'oraclehcm', 'phenom', 'adp']);

// Production DigitalOcean cadence for rook-ingest-job: overnight Eastern
// (23:00–05:30). Helpers below make that window finish a full non-held
// sweep instead of burning the last hours re-checking employers already
// touched earlier the same night.
const OVERNIGHT_TZ = 'America/New_York';
const OVERNIGHT_START_MINUTES = 23 * 60;
const OVERNIGHT_END_MINUTES = 5 * 60 + 30;

function atsCostRank(employer) {
  return EXPENSIVE_ATS.has(String(employer?.ats_type || '').toLowerCase()) ? 1 : 0;
}

function zonedParts(date, timeZone = OVERNIGHT_TZ) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function etWallTimeToUtc(year, month, day, hour, minute, timeZone = OVERNIGHT_TZ) {
  // Guess UTC from Eastern offset, then refine against Intl until the
  // zoned wall clock matches. Handles EST/EDT without a timezone lib.
  let guess = Date.UTC(year, month - 1, day, hour + 5, minute);
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(guess), timeZone);
    const asUtcMinutes = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const wantMinutes = Date.UTC(year, month - 1, day, hour, minute);
    guess += wantMinutes - asUtcMinutes;
  }
  return new Date(guess);
}

function overnightWindowStart(now = new Date(), timeZone = OVERNIGHT_TZ) {
  const parts = zonedParts(now, timeZone);
  const minutes = parts.hour * 60 + parts.minute;
  let startDay = parts;
  if (minutes < OVERNIGHT_END_MINUTES || minutes < OVERNIGHT_START_MINUTES) {
    // Before 23:00 Eastern (including the post-midnight window), the open
    // overnight sweep started on the previous calendar day at 23:00.
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    startDay = zonedParts(yesterday, timeZone);
  }
  return etWallTimeToUtc(startDay.year, startDay.month, startDay.day, 23, 0, timeZone);
}

function isInOvernightWindow(now = new Date(), timeZone = OVERNIGHT_TZ) {
  const parts = zonedParts(now, timeZone);
  const minutes = parts.hour * 60 + parts.minute;
  return minutes >= OVERNIGHT_START_MINUTES || minutes < OVERNIGHT_END_MINUTES;
}

function checkedBeforeWindow(employer, windowStartIso) {
  if (!windowStartIso) return true;
  if (!employer?.last_checked_at) return true;
  return Date.parse(employer.last_checked_at) < Date.parse(windowStartIso);
}

function orderEmployersForIngest(employers = [], { windowStart = null } = {}) {
  const windowStartIso = windowStart instanceof Date ? windowStart.toISOString() : windowStart;
  const never = [];
  const pendingTonight = [];
  const doneTonight = [];
  const held = [];
  for (const employer of employers) {
    if (employer.ingestion_hold_reason) {
      held.push(employer);
      continue;
    }
    if (!employer.last_checked_at) {
      never.push(employer);
      continue;
    }
    if (windowStartIso && !checkedBeforeWindow(employer, windowStartIso)) {
      doneTonight.push(employer);
      continue;
    }
    pendingTonight.push(employer);
  }
  // Inside the never-checked set, prefer cheap ATS first so one 2k-posting
  // Workday tenant cannot monopolize the reserved first-check window.
  never.sort((a, b) => atsCostRank(a) - atsCostRank(b));
  const byOldestThenCheap = (a, b) => {
    const byTime = new Date(a.last_checked_at || 0) - new Date(b.last_checked_at || 0);
    return byTime !== 0 ? byTime : atsCostRank(a) - atsCostRank(b);
  };
  pendingTonight.sort(byOldestThenCheap);
  doneTonight.sort(byOldestThenCheap);
  held.sort((a, b) => new Date(a.last_checked_at || 0) - new Date(b.last_checked_at || 0));
  // Overnight: finish everyone not yet touched tonight (and briefly visit
  // held skips) before spending budget on a second pass.
  if (windowStartIso) {
    return [...never, ...pendingTonight, ...held, ...doneTonight];
  }
  // Daytime / unspecified: never-checked first, then oldest remotes, held last.
  return [...never, ...pendingTonight, ...held];
}

function employerTimeBudgetMs(
  employer,
  remainingMs,
  { neverSyncedRemaining = 0, elapsedMs = 0, pendingTonightRemaining = 0, nightFinishPressure = false } = {}
) {
  const expensive = EXPENSIVE_ATS.has(String(employer?.ats_type || '').toLowerCase());
  const neverChecked = !employer?.last_checked_at;
  const backlogPressure = neverSyncedRemaining > 0 && elapsedMs < NEVER_CHECKED_RESERVE_MS;
  if (employer?.ingestion_hold_reason) return Math.min(15_000, Math.max(1_000, remainingMs - 3_000));
  // Near the end of the overnight window, shorten expensive boards so the
  // remaining unchecked employers still get a turn before 05:30 Eastern.
  if (nightFinishPressure && pendingTonightRemaining > 0) {
    const cap = expensive ? 60_000 : 90_000;
    return Math.min(cap, Math.max(5_000, remainingMs - 3_000));
  }
  if (neverChecked) {
    const cap = expensive ? (backlogPressure ? 90_000 : 150_000) : 120_000;
    return Math.min(cap, Math.max(5_000, remainingMs - 3_000));
  }
  const cap = expensive ? (backlogPressure ? 90_000 : 150_000) : 180_000;
  return Math.min(cap, Math.max(5_000, remainingMs - 3_000));
}

function shouldApplyNightFinishPressure(now = new Date(), { pendingTonightRemaining = 0 } = {}) {
  if (!isInOvernightWindow(now) || pendingTonightRemaining <= 0) return false;
  const parts = zonedParts(now);
  const minutes = parts.hour * 60 + parts.minute;
  // After 04:00 Eastern, prefer breadth so the sweep finishes.
  const lateNight = minutes >= 4 * 60 && minutes < OVERNIGHT_END_MINUTES;
  return lateNight || pendingTonightRemaining > 120;
}

module.exports = {
  TIME_BUDGET_MS,
  NEVER_CHECKED_RESERVE_MS,
  EXPENSIVE_ATS,
  OVERNIGHT_TZ,
  OVERNIGHT_START_MINUTES,
  OVERNIGHT_END_MINUTES,
  overnightWindowStart,
  isInOvernightWindow,
  checkedBeforeWindow,
  orderEmployersForIngest,
  employerTimeBudgetMs,
  shouldApplyNightFinishPressure,
};
