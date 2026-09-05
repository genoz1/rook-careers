// Pure, timezone-aware scheduling logic for the twice-daily social
// automation runs. Deliberately timezone-name-based (via Intl's
// America/New_York, the same mechanism nyWallClockToUtc in
// socialAutomation.js already relies on) rather than any fixed UTC
// offset — this is what makes DST handled correctly automatically,
// the same way it's proven correct there.
//
// Design: the actual DigitalOcean Scheduled Job invokes this
// dispatcher frequently (every 15 minutes, DO's minimum interval),
// with a time_zone of America/New_York set on the job itself so DO's
// own trigger already fires close to the right wall-clock moment.
// This module is the second, independent layer of correctness: given
// "now," it decides for itself (without trusting the trigger's exact
// timing) whether the current moment falls within the AM or PM
// window, so a slightly early/late/duplicate/retried invocation is
// harmless — it either matches a window or it doesn't, and idempotency
// (handled separately, in socialPublishWorker.js, via social_post_
// history's unique run_key) covers the "already done" case.

const TIMEZONE = "America/New_York";
const AM_TARGET = { hour: 8, minute: 30 };
const PM_TARGET = { hour: 16, minute: 30 };
const WINDOW_MINUTES = 15; // matches DO Scheduled Jobs' own minimum interval — one poll per window in the normal case

function getEasternParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  // Intl can format midnight as "24" in some environments — normalize to 0.
  const hour = parts.hour === "24" ? 0 : parseInt(parts.hour, 10);
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: parseInt(parts.minute, 10),
  };
}

function minutesSinceMidnight({ hour, minute }) {
  return hour * 60 + minute;
}

function isWithinWindow(nowParts, target, windowMinutes = WINDOW_MINUTES) {
  const nowMinutes = minutesSinceMidnight(nowParts);
  const targetMinutes = minutesSinceMidnight(target);
  return Math.abs(nowMinutes - targetMinutes) <= windowMinutes;
}

/**
 * Given the current moment, returns which slot ('am' | 'pm') is
 * currently due, or null if neither window is active right now. Never
 * returns both — the AM and PM windows (8:15-8:45, 16:15-16:45) don't
 * overlap.
 */
function determineActiveSlot(now = new Date()) {
  const nowParts = getEasternParts(now);
  if (isWithinWindow(nowParts, AM_TARGET)) return { slot: "am", dateStr: nowParts.dateStr };
  if (isWithinWindow(nowParts, PM_TARGET)) return { slot: "pm", dateStr: nowParts.dateStr };
  return null;
}

/**
 * Computes the next upcoming AM and PM run times from "now," in both
 * Eastern wall-clock and UTC — for the scheduler-status command. Pure
 * date arithmetic in the target timezone; does not depend on any
 * particular current offset, so it's correct across a DST boundary
 * between now and the computed time.
 */
function computeNextRunTimes(now = new Date()) {
  const nowParts = getEasternParts(now);
  const nowMinutes = minutesSinceMidnight(nowParts);

  function nextOccurrence(target) {
    const targetMinutes = minutesSinceMidnight(target);
    // Walk forward day by day (at most a couple of iterations) until
    // we find the next date/time at or after "now" for this target
    // wall-clock time — avoids any fixed-offset math entirely.
    for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
      const candidateDate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const candidateParts = getEasternParts(candidateDate);
      if (dayOffset === 0 && targetMinutes <= nowMinutes) continue; // today's slot already passed
      const dateStr = dayOffset === 0 ? nowParts.dateStr : candidateParts.dateStr;
      return { dateStr, hour: target.hour, minute: target.minute };
    }
    return null;
  }

  return {
    nextAm: nextOccurrence(AM_TARGET),
    nextPm: nextOccurrence(PM_TARGET),
  };
}

module.exports = {
  TIMEZONE,
  AM_TARGET,
  PM_TARGET,
  WINDOW_MINUTES,
  getEasternParts,
  isWithinWindow,
  determineActiveSlot,
  computeNextRunTimes,
};
