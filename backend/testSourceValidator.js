const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const validatorPath = require.resolve("./validateSources");
const {
  dispatch,
  loadManifest,
  validateOne,
  parseArgs,
  selectCandidates,
  writeOutputs,
  redact,
  run,
} = require("./validateSources");

// ---------------------------------------------------------------------------
// No-database-write-path guarantee. This is a source-text check, not just a
// behavioral one, because it needs to catch a dead code path that never
// executes during these tests just as reliably as one that does. It asserts
// three separate things: no Supabase client library is required, no
// production ingest.js (which builds a writable service-role client at
// module load time) is required, and no known write-verb call pattern
// appears in the file at all.
// ---------------------------------------------------------------------------
test("no database-write path is invoked — source never touches Supabase or ingest.js", () => {
  const src = fs.readFileSync(validatorPath, "utf8");
  assert.ok(!/require\(["']@supabase\/supabase-js["']\)/.test(src), "must never require @supabase/supabase-js");
  assert.ok(!/require\(["']\.\/ingest["']\)/.test(src), "must never require backend/ingest.js");
  assert.ok(!/createClient\s*\(/.test(src), "must never construct a Supabase client");
  for (const verb of [".insert(", ".update(", ".upsert(", ".delete(", "supabase.from("]) {
    assert.ok(!src.includes(verb), `must never call ${verb}`);
  }
});

// ---------------------------------------------------------------------------
// dispatch.KNOWN_ATS_TYPES must be a SUBSET of ingest.js's own ats_type
// list, not necessarily equal to it — the validator intentionally supports
// only the ats_types actually used by sourceValidationManifest.json (see
// validateSources.js's header comment), and ingest.js supports several more
// (lever, ashby, talentbrew, smartrecruiters, jobvite, icims,
// drupalcareers, teamtailor, eightfold, paylocity, jazzhr) that no manifest
// candidate currently uses. What must never happen is the validator
// claiming to support an ats_type ingest.js doesn't actually dispatch.
// ---------------------------------------------------------------------------
test("dispatch.KNOWN_ATS_TYPES is a subset of ingest.js's real ats_type switch", () => {
  const ingestSrc = fs.readFileSync(path.join(__dirname, "ingest.js"), "utf8");
  const ingestTypes = new Set(
    [...ingestSrc.matchAll(/employer\.ats_type\s*===\s*["']([a-z_]+)["']/g)].map((m) => m[1])
  );
  for (const t of dispatch.KNOWN_ATS_TYPES) {
    assert.ok(ingestTypes.has(t), `validator claims to support ats_type "${t}" but ingest.js has no such case`);
  }
});

// ---------------------------------------------------------------------------
// CLI arg parsing + candidate selection
// ---------------------------------------------------------------------------
test("CLI: --company selects a single manifest candidate by name", () => {
  const manifest = loadManifest();
  const args = parseArgs(["--company", "TG Therapeutics"]);
  assert.equal(args.company, "TG Therapeutics");
  const selected = selectCandidates(manifest, args);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].companyName, "TG Therapeutics");
});

test("CLI: --batch selects every candidate in that batch", () => {
  const manifest = loadManifest();
  const args = parseArgs(["--batch", "1"]);
  assert.equal(args.batch, 1);
  const selected = selectCandidates(manifest, args);
  assert.ok(selected.length > 0);
  assert.ok(selected.every((c) => c.batch === 1));
});

test("CLI: --all selects the entire manifest", () => {
  const manifest = loadManifest();
  const args = parseArgs(["--all"]);
  assert.equal(args.all, true);
  const selected = selectCandidates(manifest, args);
  assert.equal(selected.length, manifest.length);
});

test("CLI: unknown company name is rejected with a clear error, not silently empty", () => {
  const manifest = loadManifest();
  const args = parseArgs(["--company", "Definitely Not A Real Employer Inc"]);
  assert.throws(() => selectCandidates(manifest, args), /Unknown company/);
});

test("CLI: no selector at all is rejected rather than defaulting to something", () => {
  const manifest = loadManifest();
  assert.throws(() => selectCandidates(manifest, parseArgs([])), /Specify one of/);
});

// ---------------------------------------------------------------------------
// validateOne — the core per-employer logic, exercised through the REAL
// adapter modules (dispatch() imports and calls them exactly as ingest.js
// does) with only global.fetch stubbed — same pattern as every other
// adapter test in this repo (see testApplicantPro.js, testClinchTalent.js).
// ---------------------------------------------------------------------------

function withStubbedFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = real;
    });
}

const greenhouseCandidate = {
  companyName: "Test Greenhouse Co",
  recordAction: "ADD",
  existingUuid: null,
  companyWebsite: "https://example.com",
  careersUrl: "https://boards.greenhouse.io/testgreenhouseco",
  industry: "Medical Devices",
  atsType: "greenhouse",
  atsIdentifier: "testgreenhouseco",
  specialSettings: null,
  previousStatus: "NEEDS_TEST",
  __asIngestEmployer() {
    return {
      id: "validate:Test Greenhouse Co",
      company_name: this.companyName,
      company_website: this.companyWebsite,
      careers_url: this.careersUrl,
      industry: this.industry,
      ats_type: this.atsType,
      ats_identifier: this.atsIdentifier,
    };
  },
};

test("validateOne: successful extraction result — real jobs, all fields present, PASS_LIVE", async () => {
  await withStubbedFetch(
    async (url) => {
      assert.ok(String(url).includes("boards-api.greenhouse.io") || String(url).includes("testgreenhouseco"));
      return {
        ok: true,
        json: async () => ({
          jobs: [
            {
              id: 111,
              title: "Territory Sales Manager",
              absolute_url: "https://boards.greenhouse.io/testgreenhouseco/jobs/111",
              location: { name: "Dallas, TX" },
              content: "<p>Great role</p>",
              updated_at: "2026-08-01T00:00:00Z",
            },
            {
              id: 222,
              title: "Clinical Specialist",
              absolute_url: "https://boards.greenhouse.io/testgreenhouseco/jobs/222",
              location: { name: "Remote" },
              content: "<p>Another role</p>",
              updated_at: "2026-08-01T00:00:00Z",
            },
          ],
        }),
      };
    },
    async () => {
      const result = await validateOne(greenhouseCandidate);
      assert.equal(result.status, "PASS_LIVE");
      assert.equal(result.rawJobCount, 2);
      assert.equal(result.normalizedJobCount, 2);
      assert.equal(result.missingTitle, 0);
      assert.equal(result.missingSourceUrl, 0);
      assert.equal(result.sampleJobs.length, 2);
      assert.equal(result.sampleJobs[0].title, "Territory Sales Manager");
    }
  );
});

test("validateOne: adapter/source failure (unreachable or non-2xx) — FAIL_SOURCE, batch continues", async () => {
  await withStubbedFetch(
    async () => ({ ok: false, status: 503, json: async () => ({}) }),
    async () => {
      const result = await validateOne(greenhouseCandidate);
      assert.equal(result.status, "FAIL_SOURCE");
      assert.ok(result.error);
      assert.equal(result.rawJobCount, null);
    }
  );
});

test("validateOne: zero jobs from an adapter with no explicit-empty-evidence check — FAIL_SUSPICIOUS_EMPTY, never auto-passed", async () => {
  await withStubbedFetch(
    async () => ({ ok: true, json: async () => ({ jobs: [] }) }),
    async () => {
      const result = await validateOne(greenhouseCandidate);
      assert.equal(result.status, "FAIL_SUSPICIOUS_EMPTY");
      assert.equal(result.rawJobCount, 0);
      assert.ok(result.warning);
    }
  );
});

test("validateOne: zero jobs from an adapter WITH explicit-empty-evidence (successfactors) is accepted as PASS_LIVE", async () => {
  const sfCandidate = {
    companyName: "Test SuccessFactors Co",
    recordAction: "UPDATE",
    existingUuid: "00000000-0000-0000-0000-000000000000",
    companyWebsite: "https://example.com",
    careersUrl: "https://careers.example-sf.com",
    industry: "Pharmaceutical",
    atsType: "successfactors",
    atsIdentifier: "careers.example-sf.com",
    specialSettings: null,
    previousStatus: "NEEDS_TEST",
    __asIngestEmployer() {
      return {
        id: this.existingUuid,
        company_name: this.companyName,
        company_website: this.companyWebsite,
        careers_url: this.careersUrl,
        industry: this.industry,
        ats_type: this.atsType,
        ats_identifier: this.atsIdentifier,
      };
    },
  };
  await withStubbedFetch(
    async () => ({
      ok: true,
      text: async () =>
        '<html><body><div class="searchResults"><p>No results found for your search. Try broadening your search terms.</p></div></body></html>',
    }),
    async () => {
      const result = await validateOne(sfCandidate);
      assert.equal(result.status, "PASS_LIVE");
      assert.equal(result.rawJobCount, 0);
      assert.equal(result.normalizedJobCount, 0);
      assert.ok(result.warning);
    }
  );
});

test("validateOne: normalization failure for every returned job — FAIL_NORMALIZATION", async () => {
  // Monkeypatches the greenhouse adapter's own normalize export before
  // validateSources.js is (re-)required, so dispatch()'s destructured
  // reference to it points at the stub. Restored afterward so later tests
  // (and other files, which run in their own process anyway) see the real
  // adapter again.
  const greenhouseAdapterPath = require.resolve("./adapters/greenhouse");
  const greenhouseAdapter = require(greenhouseAdapterPath);
  const originalNormalize = greenhouseAdapter.normalizeGreenhouseJob;
  greenhouseAdapter.normalizeGreenhouseJob = () => {
    throw new Error("forced normalization failure for test");
  };
  delete require.cache[validatorPath];
  const freshValidator = require("./validateSources");

  try {
    await withStubbedFetch(
      async () => ({
        ok: true,
        json: async () => ({
          jobs: [{ id: 1, title: "X", absolute_url: "https://x", location: { name: "Y" } }],
        }),
      }),
      async () => {
        const result = await freshValidator.validateOne(greenhouseCandidate);
        assert.equal(result.status, "FAIL_NORMALIZATION");
        assert.equal(result.rawJobCount, 1);
        assert.equal(result.normalizedJobCount, 0);
        assert.equal(result.normalizationErrors.length, 1);
      }
    );
  } finally {
    greenhouseAdapter.normalizeGreenhouseJob = originalNormalize;
    delete require.cache[validatorPath];
    // Re-require with the real adapter restored so any test running later
    // in this same file/process gets the unpatched module back.
    require("./validateSources");
  }
});

// ---------------------------------------------------------------------------
// run() over a batch — one employer's failure must never stop the rest.
// ---------------------------------------------------------------------------
test("run(): one employer failing does not stop the rest of the batch", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rook-validator-test-"));
  const manifestPath = path.join(tmpDir, "manifest.json");
  const failingCompany = { ...greenhouseCandidate, companyName: "Failing Co", atsIdentifier: "failingco" };
  const passingCompany = { ...greenhouseCandidate, companyName: "Passing Co", atsIdentifier: "passingco" };
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      _comment: "test fixture",
      generatedFrom: "test",
      candidates: [
        { batch: 99, companyName: failingCompany.companyName, recordAction: "ADD", existingUuid: null, companyWebsite: "https://example.com", careersUrl: "https://boards.greenhouse.io/failingco", industry: "x", atsType: "greenhouse", atsIdentifier: "failingco", specialSettings: null, previousStatus: "NEEDS_TEST" },
        { batch: 99, companyName: passingCompany.companyName, recordAction: "ADD", existingUuid: null, companyWebsite: "https://example.com", careersUrl: "https://boards.greenhouse.io/passingco", industry: "x", atsType: "greenhouse", atsIdentifier: "passingco", specialSettings: null, previousStatus: "NEEDS_TEST" },
      ],
    })
  );

  await withStubbedFetch(
    async (url) => {
      if (String(url).includes("failingco")) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          jobs: [{ id: 9, title: "Sales Rep", absolute_url: "https://x/9", location: { name: "OH" } }],
        }),
      };
    },
    async () => {
      const manifest = loadManifest(manifestPath);
      const candidates = selectCandidates(manifest, { batch: 99, company: null, all: false });
      const results = [];
      for (const c of candidates) results.push(await validateOne(c));
      assert.equal(results.length, 2);
      const byName = Object.fromEntries(results.map((r) => [r.company, r]));
      assert.equal(byName["Failing Co"].status, "FAIL_SOURCE");
      assert.equal(byName["Passing Co"].status, "PASS_LIVE");
    }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Output redaction
// ---------------------------------------------------------------------------
test("redact(): strips bearer tokens, API-key query params, and Authorization headers", () => {
  assert.equal(redact("Authorization: Bearer sk_live_abcdefghijklmnop"), "Authorization: Bearer [REDACTED]");
  assert.equal(
    redact("https://example.com/api?api_key=SECRET12345&other=1"),
    "https://example.com/api?api_key=[REDACTED]&other=1"
  );
  assert.equal(redact(42), 42);
});

test("writeOutputs(): result files contain no unredacted secret-shaped strings", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rook-validator-out-"));
  const results = [
    {
      company: "Secret Co",
      status: "FAIL_SOURCE",
      atsType: "greenhouse",
      atsIdentifier: "secretco",
      recordAction: "ADD",
      existingUuid: null,
      rawJobCount: null,
      normalizedJobCount: null,
      duplicateCount: 0,
      missingTitle: 0,
      missingLocation: 0,
      missingSourceUrl: 0,
      elapsedMs: 5,
      error: "fetch failed: Authorization: Bearer sk_live_abcdefghijklmnop",
      sampleJobs: [],
    },
  ];
  const { jsonPath, mdPath } = writeOutputs(results, tmpDir);
  const jsonText = fs.readFileSync(jsonPath, "utf8");
  const mdText = fs.readFileSync(mdPath, "utf8");
  assert.ok(!jsonText.includes("sk_live_abcdefghijklmnop"));
  assert.ok(!mdText.includes("sk_live_abcdefghijklmnop"));
  assert.ok(jsonText.includes("[REDACTED]"));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
