// Tests for backend/socialScheduler.js — pure timezone/window logic,
// no external dependencies at all. Run with:
//   node backend/testSocialScheduler.js

const assert = require("assert");
const {
  determineActiveSlot, isWithinWindow, getEasternParts, computeNextRunTimes, WINDOW_MINUTES,
} = require("./socialScheduler");

let passCount = 0, failCount = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passCount++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failCount++; }
}

console.log("\n=== DST correctness: America/New_York, not fixed UTC offsets ===");
test("8:30 AM EST (winter, UTC-5) is correctly detected as the AM window", () => {
  const result = determineActiveSlot(new Date("2026-01-15T13:30:00Z"));
  assert.deepStrictEqual(result, { slot: "am", dateStr: "2026-01-15" });
});
test("8:30 AM EDT (summer, UTC-4) is correctly detected as the AM window — same wall-clock time, different UTC offset", () => {
  const result = determineActiveSlot(new Date("2026-07-15T12:30:00Z"));
  assert.deepStrictEqual(result, { slot: "am", dateStr: "2026-07-15" });
});
test("4:30 PM EST (winter) is correctly detected as the PM window", () => {
  const result = determineActiveSlot(new Date("2026-01-15T21:30:00Z"));
  assert.deepStrictEqual(result, { slot: "pm", dateStr: "2026-01-15" });
});
test("4:30 PM EDT (summer) is correctly detected as the PM window", () => {
  const result = determineActiveSlot(new Date("2026-07-15T20:30:00Z"));
  assert.deepStrictEqual(result, { slot: "pm", dateStr: "2026-07-15" });
});
test("spring-forward transition day (2026-03-08): the AM window still lands on real 8:30 ET wall-clock time", () => {
  const result = determineActiveSlot(new Date("2026-03-08T12:30:00Z"));
  assert.deepStrictEqual(result, { slot: "am", dateStr: "2026-03-08" });
  const wrongOffset = determineActiveSlot(new Date("2026-03-08T13:30:00Z"));
  assert.strictEqual(wrongOffset, null, "13:30 UTC that day is 9:30am ET (EDT), outside the AM window — a fixed pre-transition offset would have wrongly matched this");
});
test("fall-back transition day (2026-11-01): the PM window still lands on real 4:30 ET wall-clock time", () => {
  const result = determineActiveSlot(new Date("2026-11-01T21:30:00Z"));
  assert.deepStrictEqual(result, { slot: "pm", dateStr: "2026-11-01" });
});

console.log("\n=== Window boundaries ===");
test("just inside the AM window boundary (15 minutes early) still matches", () => {
  assert.ok(isWithinWindow({ hour: 8, minute: 15 }, { hour: 8, minute: 30 }, WINDOW_MINUTES));
});
test("just outside the AM window boundary (16 minutes early) does not match", () => {
  assert.ok(!isWithinWindow({ hour: 8, minute: 14 }, { hour: 8, minute: 30 }, WINDOW_MINUTES));
});
test("a time far from both windows (e.g. noon) matches neither", () => {
  assert.strictEqual(determineActiveSlot(new Date("2026-01-15T17:00:00Z")), null);
});
test("the AM and PM windows never overlap — a single moment is never both", () => {
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 15, 30, 45]) {
      const nowParts = { hour, minute };
      const am = isWithinWindow(nowParts, { hour: 8, minute: 30 });
      const pm = isWithinWindow(nowParts, { hour: 16, minute: 30 });
      assert.ok(!(am && pm), `hour=${hour} minute=${minute} matched both windows`);
    }
  }
});

console.log("\n=== getEasternParts ===");
test("correctly extracts date/hour/minute for a known UTC instant", () => {
  const parts = getEasternParts(new Date("2026-06-15T16:45:00Z"));
  assert.strictEqual(parts.dateStr, "2026-06-15");
  assert.strictEqual(parts.hour, 12);
  assert.strictEqual(parts.minute, 45);
});
test("correctly handles a date that differs between UTC and Eastern (near midnight)", () => {
  const parts = getEasternParts(new Date("2026-01-16T03:00:00Z"));
  assert.strictEqual(parts.dateStr, "2026-01-15", "the ET calendar date must be used, not the UTC one");
});

console.log("\n=== computeNextRunTimes ===");
test("before 8:30am ET, the next AM run is today", () => {
  const { nextAm } = computeNextRunTimes(new Date("2026-01-15T12:00:00Z"));
  assert.strictEqual(nextAm.dateStr, "2026-01-15");
});
test("after 8:30am ET but before 4:30pm ET, the next AM run is tomorrow", () => {
  const { nextAm } = computeNextRunTimes(new Date("2026-01-15T15:00:00Z"));
  assert.strictEqual(nextAm.dateStr, "2026-01-16");
});
test("after 4:30pm ET, the next PM run is tomorrow", () => {
  const { nextPm } = computeNextRunTimes(new Date("2026-01-15T23:00:00Z"));
  assert.strictEqual(nextPm.dateStr, "2026-01-16");
});

console.log(`\n${passCount} passed, ${failCount} failed\n`);
if (failCount > 0) process.exit(1);
