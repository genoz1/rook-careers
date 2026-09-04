// Tests for the résumé-achievements fix (backend/ai/resumeAnalysis.js).
// Same plain-node-script convention as testTrialFlow.js — no test
// framework. Run with:
//   node backend/testResumeAchievements.js
//
// Root cause this guards against: the AI's own JSON schema never asked
// for a per-employer achievements field at all — company/title/dates
// were requested and correctly populated, achievements simply weren't
// part of the contract, so they were always blank regardless of what
// the résumé actually said. Mocks the AI call (via analyzeResume's
// injectable `callAI` parameter) so these tests never hit a real
// Anthropic API — they verify the PROMPT CONTRACT and the SHAPE of
// data flowing through analyzeResume(), not the AI's actual judgment
// call on any specific résumé.

const assert = require("assert");
const { analyzeResume, SYSTEM_PROMPT } = require("./ai/resumeAnalysis");

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failCount++;
  }
}

// A realistic 3-job résumé (as extracted plain text would look — the
// same shape backend/resumeParser.js hands to analyzeResume) with
// distinct, non-overlapping bullet points under two of the three
// roles, and NO bullets at all under the oldest role — covering both
// halves of the requirement: achievements must stay attributed to the
// correct job, and a role with none must end up null, not invented.
const FIXTURE_RESUME_TEXT = `
Jordan Ellis
Territory Sales Manager

EXPERIENCE

Regional Sales Manager — Apex Diagnostics
March 2022 – Present
- Grew territory revenue 34% year-over-year across a 6-state Southeast region
- Closed the largest single reference-lab contract in company history ($1.2M ACV)
- Trained and onboarded 4 new territory reps in the first year

Territory Manager — VetCore Animal Health
June 2018 – February 2022
- Ranked #2 of 40 reps nationally for new-account acquisition in 2020
- Launched the company's first point-of-care platform in an 8-clinic pilot group

Sales Associate — MedSupply Direct
January 2015 – May 2018
`.trim();

async function run() {
  console.log("\n=== Schema contract: the AI prompt actually requests per-employer achievements ===");

  await test("SYSTEM_PROMPT's employers schema includes an achievements field", () => {
    assert.ok(/employers.*achievements/s.test(SYSTEM_PROMPT), "the employers array schema must define an achievements field, or this exact regression can recur silently");
  });

  await test("SYSTEM_PROMPT explicitly instructs against inventing or mixing achievements across jobs", () => {
    assert.ok(/never invent/i.test(SYSTEM_PROMPT), "must instruct against fabricating achievements");
    assert.ok(/never move or copy a bullet from one job into another/i.test(SYSTEM_PROMPT), "must explicitly instruct against combining achievements across different employers");
  });

  console.log("\n=== End-to-end (AI call mocked): achievements stay attributed to the correct job ===");

  await test("multiple employers with distinct achievements: none migrate between jobs", async () => {
    // Simulates exactly what a correctly-behaving AI call should
    // return for FIXTURE_RESUME_TEXT above — this is the contract
    // analyzeResume() is responsible for requesting and passing
    // through untouched, not for re-deriving itself.
    const fakeAiResponse = {
      industries_experience: [], product_categories: [], customer_types: [], sales_motion: [],
      seniority_level: null, total_sales_years: null, management_experience: false,
      clinical_technical_experience: [], specialties: [], certifications: [], performance_highlights: [],
      employers: [
        {
          company: "Apex Diagnostics", title: "Regional Sales Manager", start: "2022-03", end: null,
          achievements: "Grew territory revenue 34% year-over-year across a 6-state Southeast region\nClosed the largest single reference-lab contract in company history ($1.2M ACV)\nTrained and onboarded 4 new territory reps in the first year",
        },
        {
          company: "VetCore Animal Health", title: "Territory Manager", start: "2018-06", end: "2022-02",
          achievements: "Ranked #2 of 40 reps nationally for new-account acquisition in 2020\nLaunched the company's first point-of-care platform in an 8-clinic pilot group",
        },
        {
          company: "MedSupply Direct", title: "Sales Associate", start: "2015-01", end: "2018-05",
          achievements: null, // no bullets under this role in the fixture at all
        },
      ],
    };

    let capturedSystemPrompt = null;
    let capturedUserPrompt = null;
    const fakeCallAI = async (systemPrompt, userPrompt) => {
      capturedSystemPrompt = systemPrompt;
      capturedUserPrompt = userPrompt;
      return fakeAiResponse;
    };

    const result = await analyzeResume(FIXTURE_RESUME_TEXT, { callAI: fakeCallAI });

    // Confirms analyzeResume actually sends the achievements-requesting
    // prompt (not some other/stale copy) and the real fixture text.
    assert.ok(capturedSystemPrompt.includes("achievements"), "must send the achievements-requesting system prompt");
    assert.ok(capturedUserPrompt.includes("Apex Diagnostics"), "must send the actual résumé text to the AI");

    assert.strictEqual(result.employers.length, 3);

    const [apex, vetcore, medsupply] = result.employers;

    assert.ok(apex.achievements.includes("34% year-over-year"), "Apex's own achievement must be present");
    assert.ok(!apex.achievements.includes("#2 of 40 reps"), "VetCore's achievement must NOT appear under Apex");
    assert.ok(!apex.achievements.includes("point-of-care platform"), "VetCore's second achievement must NOT appear under Apex either");

    assert.ok(vetcore.achievements.includes("#2 of 40 reps"), "VetCore's own achievement must be present");
    assert.ok(vetcore.achievements.includes("point-of-care platform"), "VetCore's second achievement must be present");
    assert.ok(!vetcore.achievements.includes("34% year-over-year"), "Apex's achievement must NOT appear under VetCore");
    assert.ok(!vetcore.achievements.includes("$1.2M ACV"), "Apex's other achievement must NOT appear under VetCore");

    assert.strictEqual(medsupply.achievements, null, "an employer with no bullets in the résumé must stay null, not receive invented content");
  });

  await test("an employer with no achievements at all stays blank/null even when siblings have several", async () => {
    // Narrower, more targeted repeat of the null-handling assertion
    // above, isolated as its own test per the direct request to cover
    // this case explicitly.
    const fakeCallAI = async () => ({
      employers: [
        { company: "Has Bullets Inc", title: "Rep", start: "2020-01", end: null, achievements: "Exceeded quota every quarter" },
        { company: "No Bullets LLC", title: "Rep", start: "2018-01", end: "2019-12", achievements: null },
      ],
    });
    const result = await analyzeResume(FIXTURE_RESUME_TEXT, { callAI: fakeCallAI });
    assert.strictEqual(result.employers[0].achievements, "Exceeded quota every quarter");
    assert.strictEqual(result.employers[1].achievements, null, "must remain null — no fabricated achievement text");
  });

  await test("analyzeResume still rejects too-short résumé text before ever calling the AI", async () => {
    let called = false;
    const fakeCallAI = async () => { called = true; return {}; };
    await assert.rejects(
      () => analyzeResume("too short", { callAI: fakeCallAI }),
      /too short or empty/,
    );
    assert.strictEqual(called, false, "must not call the AI at all for input that fails the length check — existing behavior, unrelated to this fix, confirmed unchanged");
  });

  console.log(`\n${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
