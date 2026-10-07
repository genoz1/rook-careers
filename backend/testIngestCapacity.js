// Tests for the two capacity/safety changes made to backend/ingest.js in
// the Nightly Ingestion Capacity Review (Sept 2026):
//   1. GEOCODE_CAP_PER_EMPLOYER — a never-synced/large employer can no
//      longer force an unbounded number of throttled geocode lookups in
//      one run.
//   2. tryAcquireIngestLock()/releaseIngestLock() — a lightweight,
//      fail-open overlap guard for two scheduled runs landing close
//      together.
//
// Uses the same in-memory Supabase-client-fake pattern as
// testOnboardingV7.js (require.cache substitution for
// @supabase/supabase-js), extended with the extra query methods
// ingest.js itself uses (.not, .or, .in, .single).

const assert = require("node:assert/strict");
const { test } = require("node:test");

// backend/ingest.js -> backend/socialAutomation.js -> backend/routes/jobs.js,
// and routes/jobs.js registers module-level setInterval() cleanup timers
// (rate-limit map pruning) with no .unref(), purely as a side effect of
// being required — nothing to do with ingestion or this test file, and
// out of scope to change here (routes/jobs.js is unrelated to the
// ingestion-capacity work this file tests). Left as-is, those timers keep
// the process alive well past every test having already passed — and
// process._getActiveHandles() doesn't reliably list them on this Node
// version to unref after the fact (confirmed directly: it reported zero
// handles while process.getActiveResourcesInfo() showed three live
// Timeouts). So instead, setInterval is wrapped for the duration of the
// one require() call that first pulls in that module chain, auto-unref'ing
// whatever it creates — a self-contained shim local to this test file,
// not a change to any production file.
function requireWithUnreffedIntervals(fn) {
  const originalSetInterval = global.setInterval;
  global.setInterval = (...args) => {
    const t = originalSetInterval(...args);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  };
  try {
    return fn();
  } finally {
    global.setInterval = originalSetInterval;
  }
}

process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";

class Query {
  constructor(tableName, tables, operations) {
    this.tableName = tableName;
    this.tables = tables;
    this.operations = operations;
    this.filters = [];
    this.kind = "select";
  }
  select() { return this; }
  eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
  is(k, v) { this.filters.push((r) => (r[k] ?? null) === v); return this; }
  not(k, _op, v) { this.filters.push((r) => (r[k] ?? null) !== v); return this; }
  in(k, arr) { this.filters.push((r) => arr.includes(r[k])); return this; }
  order() { return this; }
  range(start, end) { this._range = [start, end]; return this; }
  // Handles the two shapes ingest.js actually builds: the lock's
  // "locked_at.is.null,locked_at.lt.<iso>" and the debug-filter's
  // "company_name.ilike.%x%,company_slug.ilike.%x%". A narrow,
  // hand-rolled parse of just those two shapes, not a general
  // PostgREST filter-string parser.
  or(expr) {
    const parts = expr.split(",");
    this.filters.push((r) =>
      parts.some((p) => {
        const [col, op, ...rest] = p.split(".");
        const val = rest.join(".");
        if (op === "is" && val === "null") return (r[col] ?? null) === null;
        if (op === "lt") return r[col] != null && r[col] < val;
        if (op === "ilike") {
          const needle = val.replace(/^%|%$/g, "").toLowerCase();
          return String(r[col] ?? "").toLowerCase().includes(needle);
        }
        return false;
      })
    );
    return this;
  }
  insert(data) { this.kind = "insert"; this.payload = data; return this; }
  update(data) { this.kind = "update"; this.payload = data; return this; }
  upsert(data) { this.kind = "upsert"; this.payload = data; return this; }
  // NOTE: this flag is deliberately named `_wantSingle`, not `single` —
  // naming it the same as the `single()` method above previously meant
  // every query's own `this.single` property lookup fell through to the
  // inherited method itself (always truthy, since it's a function),
  // silently forcing every plain select() to be treated as
  // .single()/.maybeSingle() and hanging the whole suite when ingest.js
  // then called .filter()/.map() on what it got back as a single object
  // instead of an array. Caught by actually running the tests, not
  // assumed.
  maybeSingle() { this._wantSingle = true; return this; }
  single() { this._wantSingle = true; return this; }
  then(resolve, reject) {
    return Promise.resolve()
      .then(() => {
        this.operations.push({ table: this.tableName, kind: this.kind, payload: structuredClone(this.payload) });
        if (!this.tables[this.tableName]) {
          return { data: null, error: { message: `relation "${this.tableName}" does not exist` } };
        }
        const rows = this.tables[this.tableName];
        let matches = rows.filter((r) => this.filters.every((f) => f(r)));
        if (this.kind === "insert") {
          rows.push({ id: `${this.tableName}-${rows.length + 1}`, ...this.payload });
          matches = [rows.at(-1)];
        }
        if (this.kind === "upsert") {
          let row = rows.find((r) => r.employer_id === this.payload.employer_id && r.source_job_id === this.payload.source_job_id);
          if (!row) { row = { id: `${this.tableName}-${rows.length + 1}` }; rows.push(row); }
          Object.assign(row, this.payload);
          matches = [row];
        }
        if (this.kind === "update") for (const row of matches) Object.assign(row, this.payload);
        if (this.kind === 'select' && this._range) matches = matches.slice(this._range[0], this._range[1] + 1);
        return { data: structuredClone(this._wantSingle ? matches[0] || null : matches), error: null };
      })
      .then(resolve, reject);
  }
}

function makeDb(tables) {
  const operations = [];
  return { from: (name) => new Query(name, tables, operations), operations };
}

function freshIngest(tables, { geocodeImpl, analyzeJobImpl, embeddingImpl, deterministicAnalysisImpl } = {}) {
  const db = makeDb(tables);
  require.cache[require.resolve("@supabase/supabase-js")] = { exports: { createClient: () => db } };

  const geocodingPath = require.resolve("./geocoding");
  delete require.cache[geocodingPath];
  const geocodingModule = require(geocodingPath);
  let geocodeCallCount = 0;
  geocodingModule.geocodeLocation = async (text, opts) => {
    geocodeCallCount++;
    // The source fixture says Dallas, TX. A point in Ohio is rightly
    // rejected by the current location validator as a wrong-state match.
    return geocodeImpl ? geocodeImpl(text, opts) : { lat: 32.78, lng: -96.8, state: "Texas" };
  };

  const jobAnalysisPath = require.resolve("./ai/jobAnalysis");
  require.cache[jobAnalysisPath] = {
    exports: { analyzeJob: analyzeJobImpl || (async () => ({ product_categories: ["Medical Devices"], required_industries: [], sales_motion: ["field"] })) },
  };
  const embeddingsPath = require.resolve("./ai/embeddings");
  let embeddingCallCount = 0;
  require.cache[embeddingsPath] = { exports: { generateEmbedding: async (...args) => {
    embeddingCallCount++;
    return embeddingImpl ? embeddingImpl(...args) : [0.1, 0.2, 0.3];
  } } };

  const deterministicPath = require.resolve("./deterministicJobAnalysis");
  delete require.cache[deterministicPath];
  const realDeterministic = require(deterministicPath);
  let deterministicAnalysisCallCount = 0;
  require.cache[deterministicPath] = { exports: {
    ...realDeterministic,
    deterministicJobAnalysis: (...args) => {
      deterministicAnalysisCallCount++;
      return deterministicAnalysisImpl
        ? deterministicAnalysisImpl(...args)
        : realDeterministic.deterministicJobAnalysis(...args);
    },
  } };

  delete require.cache[require.resolve("./ingest")];
  const ingest = requireWithUnreffedIntervals(() => require("./ingest"));
  return {
    ingest,
    getGeocodeCallCount: () => geocodeCallCount,
    getEmbeddingCallCount: () => embeddingCallCount,
    getDeterministicAnalysisCallCount: () => deterministicAnalysisCallCount,
    getOperations: () => db.operations,
  };
}

function greenhouseFetchStub(jobCount) {
  const jobs = [];
  for (let i = 0; i < jobCount; i++) {
    jobs.push({
      id: 1000 + i,
      title: `Territory Sales Manager ${i}`,
      absolute_url: `https://boards.greenhouse.io/testco/jobs/${1000 + i}`,
      location: { name: "Dallas, TX" },
      content: "<p>Great sales role</p>",
      updated_at: "2026-09-01T00:00:00Z",
    });
  }
  return async () => ({ ok: true, json: async () => ({ jobs }) });
}

const baseEmployer = {
  id: "employer-1",
  company_name: "Test Co",
  company_website: "https://example.com",
  careers_url: "https://boards.greenhouse.io/testco",
  industry: "Medical Devices",
  ats_type: "greenhouse",
  ats_identifier: "testco",
  active: true,
  last_checked_at: null,
};

function existingGreenhouseJob(overrides = {}) {
  return {
    id: "existing-job",
    employer_id: baseEmployer.id,
    source_job_id: "1000",
    source_type: "greenhouse",
    source_url: "https://boards.greenhouse.io/testco/jobs/1000",
    application_url: "https://boards.greenhouse.io/testco/jobs/1000",
    title_original: "Territory Sales Manager 0",
    company_name: baseEmployer.company_name,
    description_html: "<p>Great sales role</p>",
    description_text: "Great sales role",
    location_raw: "Dallas, TX",
    date_posted: "2026-09-01",
    status: "active",
    source_verified: true,
    ai_analysis: { analysis_source: "existing" },
    job_embedding: [0.9, 0.8],
    job_lat: 32.78,
    job_lng: -96.8,
    state: "Texas",
    location_evidence: {
      version: require("./jobLocationScope").VERSION,
      status: "validated",
      source_location: "Dallas, TX",
      source_title: "Territory Sales Manager 0",
      source_description_hash: require("./jobLocationScope").descriptionHash("Great sales role"),
      source_country_code: "US",
      checked_at: new Date().toISOString(),
      geocoded_location: "Dallas, TX",
      scope: { kind: "local", reason: "explicit_city_state" },
    },
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Incremental source comparison
// ---------------------------------------------------------------------------
test("ingestEmployer: unchanged job receives only freshness work and skips geocoding, analysis, and embeddings", async () => {
  const job = existingGreenhouseJob();
  const tables = { jobs: [job], employers: [{ ...baseEmployer }] };
  const counters = freshIngest(tables);
  const oldLastSeen = job.last_seen_at;
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(1);
  let measured;
  try {
    measured = await require("./ingestRunMetrics").measure(() => counters.ingest.ingestEmployer(tables.employers[0]));
  } finally {
    global.fetch = realFetch;
  }

  assert.equal(counters.getGeocodeCallCount(), 0);
  assert.equal(counters.getDeterministicAnalysisCallCount(), 0);
  assert.equal(counters.getEmbeddingCallCount(), 0);
  assert.equal(measured.metrics.unchanged, 1);
  assert.equal(measured.metrics.updated, 0);
  assert.notEqual(tables.jobs[0].last_seen_at, oldLastSeen);
  assert.equal(tables.jobs[0].first_seen_at, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(tables.jobs[0].ai_analysis, { analysis_source: "existing" });
  assert.deepEqual(tables.jobs[0].job_embedding, [0.9, 0.8]);
});

test("ingestEmployer: unchanged jobs batch freshness writes instead of issuing per-job upserts", async () => {
  const jobs = Array.from({ length: 501 }, (_, index) => {
    const sourceId = String(1000 + index);
    const title = `Territory Sales Manager ${index}`;
    return existingGreenhouseJob({
      id: `existing-${sourceId}`,
      source_job_id: sourceId,
      source_url: `https://boards.greenhouse.io/testco/jobs/${sourceId}`,
      application_url: `https://boards.greenhouse.io/testco/jobs/${sourceId}`,
      title_original: title,
      location_evidence: { ...existingGreenhouseJob().location_evidence, source_title: title },
    });
  });
  const tables = { jobs, employers: [{ ...baseEmployer }] };
  const counters = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(501);
  try { await counters.ingest.ingestEmployer(tables.employers[0]); } finally { global.fetch = realFetch; }

  const jobWrites = counters.getOperations().filter((operation) => operation.table === "jobs" && operation.kind !== "select");
  assert.equal(jobWrites.filter((operation) => operation.kind === "update" && Object.keys(operation.payload).length === 1 && operation.payload.last_seen_at).length, 2);
  assert.equal(jobWrites.filter((operation) => ["insert", "upsert"].includes(operation.kind)).length, 0);
  assert.equal(counters.getGeocodeCallCount(), 0);
  assert.equal(counters.getDeterministicAnalysisCallCount(), 0);
  assert.equal(counters.getEmbeddingCallCount(), 0);
});

test("ingestEmployer: materially changed existing job follows enrichment path", async () => {
  const original = existingGreenhouseJob();
  const job = existingGreenhouseJob({
    description_html: "<p>Old sales role</p>",
    description_text: "Old sales role",
    location_evidence: {
      ...original.location_evidence,
      source_description_hash: require("./jobLocationScope").descriptionHash("Old sales role"),
    },
  });
  const tables = { jobs: [job], employers: [{ ...baseEmployer }] };
  const counters = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(1);
  try { await counters.ingest.ingestEmployer(tables.employers[0]); } finally { global.fetch = realFetch; }

  assert.equal(counters.getGeocodeCallCount(), 1);
  assert.equal(counters.getDeterministicAnalysisCallCount(), 1);
  assert.equal(counters.getEmbeddingCallCount(), 1);
  assert.equal(tables.jobs[0].description_text, "Great sales role");
});

test("ingestEmployer: new job follows normal enrichment path", async () => {
  const tables = { jobs: [], employers: [{ ...baseEmployer }] };
  const counters = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(1);
  try { await counters.ingest.ingestEmployer(tables.employers[0]); } finally { global.fetch = realFetch; }

  assert.equal(counters.getGeocodeCallCount(), 1);
  assert.equal(counters.getDeterministicAnalysisCallCount(), 1);
  assert.equal(counters.getEmbeddingCallCount(), 1);
  assert.equal(tables.jobs.length, 1);
});

test("ingestEmployer: incomplete snapshot refreshes present jobs but never closes disappeared jobs", async () => {
  const current = existingGreenhouseJob();
  const stale = existingGreenhouseJob({ id: "stale-job", source_job_id: "999", title_original: "Territory Sales Manager stale" });
  const tables = { jobs: [current, stale], employers: [{ ...baseEmployer }] };
  const { ingest } = freshIngest(tables);
  const jobs = [{
    id: 1000,
    title: "Territory Sales Manager 0",
    absolute_url: "https://boards.greenhouse.io/testco/jobs/1000",
    location: { name: "Dallas, TX" },
    content: "<p>Great sales role</p>",
    updated_at: "2026-09-01T00:00:00Z",
  }];
  jobs.incompleteSnapshot = true;
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ jobs }) });
  let result;
  try { result = await ingest.ingestEmployer(tables.employers[0]); } finally { global.fetch = realFetch; }

  assert.equal(result.status, "partial");
  assert.equal(tables.jobs.find((row) => row.source_job_id === "999").status, "active");
});

// ---------------------------------------------------------------------------
// Geocode cap
// ---------------------------------------------------------------------------
test("ingestEmployer: never-synced employer with more relevant jobs than the geocode cap defers the rest, doesn't loop forever or crash", async () => {
  const tables = { jobs: [], employers: [{ ...baseEmployer }] };
  const { ingest, getGeocodeCallCount } = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(55); // > GEOCODE_CAP_PER_EMPLOYER (40)
  try {
    await ingest.ingestEmployer(tables.employers[0]);
  } finally {
    global.fetch = realFetch;
  }

  assert.equal(getGeocodeCallCount(), 40, "geocode should stop being called once the per-employer cap is reached");
  assert.equal(tables.jobs.length, 55, "every relevant job is still saved even once geocoding is deferred");
  const withCoords = tables.jobs.filter((j) => j.job_lat != null);
  const withoutCoords = tables.jobs.filter((j) => j.job_lat == null);
  assert.equal(withCoords.length, 40, "jobs within the cap got real coordinates");
  assert.ok(withoutCoords.length >= 15, "jobs beyond the cap were saved without coordinates, not dropped");
});

test("ingestEmployer: fewer relevant jobs than the geocode cap — every one gets geocoded, nothing deferred", async () => {
  const tables = { jobs: [], employers: [{ ...baseEmployer, id: "employer-2" }] };
  const { ingest, getGeocodeCallCount } = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(12);
  try {
    await ingest.ingestEmployer(tables.employers[0]);
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(getGeocodeCallCount(), 12);
  assert.equal(tables.jobs.filter((j) => j.job_lat != null).length, 12);
});

test("ingestEmployer: unavailable Anthropic cannot crash or discard obvious sales jobs", async () => {
  const tables = { jobs: [], employers: [{ ...baseEmployer, id: "employer-no-anthropic" }] };
  const { ingest } = freshIngest(tables, { analyzeJobImpl: async () => { throw new Error("Anthropic unavailable"); } });
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(1);
  try { await ingest.ingestEmployer(tables.employers[0]); } finally { global.fetch = realFetch; }
  assert.equal(tables.jobs.length, 1);
  assert.equal(tables.jobs[0].status, "active");
  assert.equal(tables.jobs[0].ai_analysis.analysis_source, "deterministic_evidence");
});

test("ingestEmployer: closes a previously stored job that the current relevance filter excludes", async () => {
  const employer = { ...baseEmployer, id: 'employer-relevance' };
  const tables = {
    employers: [employer],
    jobs: [{ id: 'old-job', employer_id: employer.id, source_job_id: '1000', title_original: 'Sales Training Manager', status: 'active' }],
  };
  const { ingest } = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ jobs: [{
    id: 1000, title: 'Sales Training Manager', absolute_url: 'https://boards.greenhouse.io/testco/jobs/1000',
    location: { name: 'Dallas, TX' }, content: '<p>Training role</p>',
  }] }) });
  try { await ingest.ingestEmployer(employer); } finally { global.fetch = realFetch; }
  assert.equal(tables.jobs[0].status, 'closed');
});

test("ingestEmployer: abnormally small snapshot preserves stale jobs beyond the first 1000 stored rows", async () => {
  const employer = { ...baseEmployer, id: "employer-paginated" };
  const tables = {
    employers: [employer],
    jobs: Array.from({ length: 1005 }, (_, i) => ({
      id: `old-${i}`,
      employer_id: employer.id,
      source_job_id: String(1000 + i),
      title_original: `Territory Sales Manager ${i}`,
      status: "active",
    })),
  };
  const { ingest } = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(1);
  let result;
  try { result = await ingest.ingestEmployer(employer); } finally { global.fetch = realFetch; }
  assert.equal(result.status, 'partial');
  assert.match(result.warnings.join(' '), /Abnormally small snapshot/);
  assert.equal(tables.jobs.filter((job) => job.status === "closed").length, 0);
  assert.equal(tables.jobs.find((job) => job.source_job_id === "1000").status, "active");
});

test("ingestEmployer: a job whose location was already validated in a prior run reuses the cached point and never counts against the cap", async () => {
  const tables = {
    jobs: [
      {
        employer_id: "employer-3",
        source_job_id: "1000",
        location_raw: "Dallas, TX",
        job_lat: 32.78,
        job_lng: -96.8,
        state: "Texas",
        // Only current-version evidence is reusable; version 1 is intentionally
        // revalidated after the source-backed location safety upgrade.
        location_evidence: { version: require('./jobLocationScope').VERSION, status: "validated", source_location: "Dallas, TX", source_title: "Territory Sales Manager 0", source_description_hash: require('./jobLocationScope').descriptionHash("Great sales role"), source_country_code: "US", checked_at: new Date().toISOString(), geocoded_location: "Dallas, TX", scope: { kind: "local", reason: "explicit_city_state" } },
        title_original: "Territory Sales Manager 0",
        description_text: "Great sales role",
        status: "active",
      },
    ],
    employers: [{ ...baseEmployer, id: "employer-3" }],
  };
  const { ingest, getGeocodeCallCount } = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(1); // same source_job_id (1000) as the cached row above
  try {
    await ingest.ingestEmployer(tables.employers[0]);
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(getGeocodeCallCount(), 0, "a cached, still-valid location must not trigger a fresh geocode call");
});

// ---------------------------------------------------------------------------
// Overlap lock
// ---------------------------------------------------------------------------
test("tryAcquireIngestLock: acquires when the row is unlocked", async () => {
  const tables = { ingestion_run_lock: [{ id: 1, locked_at: null, locked_by: null }] };
  const { ingest } = freshIngest(tables);
  const result = await ingest.tryAcquireIngestLock();
  assert.equal(result.acquired, true);
  assert.equal(result.failOpen, false);
  assert.ok(tables.ingestion_run_lock[0].locked_at, "lock row should now show a lock time");
});

test("tryAcquireIngestLock: refuses when the row is locked and fresh", async () => {
  const tables = { ingestion_run_lock: [{ id: 1, locked_at: new Date().toISOString(), locked_by: "pid:999" }] };
  const { ingest } = freshIngest(tables);
  const result = await ingest.tryAcquireIngestLock();
  assert.equal(result.acquired, false);
});

test("tryAcquireIngestLock: acquires when the row is locked but stale (older than the timeout)", async () => {
  const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  const tables = { ingestion_run_lock: [{ id: 1, locked_at: staleTime, locked_by: "pid:111" }] };
  const { ingest } = freshIngest(tables);
  const result = await ingest.tryAcquireIngestLock();
  assert.equal(result.acquired, true);
});

test("tryAcquireIngestLock: fails OPEN (treated as acquired) when the lock table doesn't exist yet", async () => {
  const tables = {}; // no ingestion_run_lock table at all — migration not applied
  const { ingest } = freshIngest(tables);
  const result = await ingest.tryAcquireIngestLock();
  assert.equal(result.acquired, true);
  assert.equal(result.failOpen, true, "must fail open, never block ingestion just because the migration hasn't run yet");
});

test("releaseIngestLock: clears locked_at/locked_by", async () => {
  const tables = { ingestion_run_lock: [{ id: 1, locked_at: new Date().toISOString(), locked_by: "pid:1" }] };
  const { ingest } = freshIngest(tables);
  await ingest.releaseIngestLock();
  assert.equal(tables.ingestion_run_lock[0].locked_at, null);
  assert.equal(tables.ingestion_run_lock[0].locked_by, null);
});

test("run(): when the lock cannot be acquired, no employer is processed at all", async () => {
  const tables = {
    ingestion_run_lock: [{ id: 1, locked_at: new Date().toISOString(), locked_by: "pid:other" }],
    employers: [{ ...baseEmployer, id: "employer-locked-test" }],
    jobs: [],
  };
  const { ingest } = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network should never be reached — run() must exit before querying employers");
  };
  try {
    await ingest.run();
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(tables.jobs.length, 0, "no job should have been written — the run must exit before the employer loop starts");
});

test("run(): a single-employer debug invocation (argv filter) bypasses the lock entirely", async () => {
  const tables = {
    ingestion_run_lock: [{ id: 1, locked_at: new Date().toISOString(), locked_by: "pid:other" }],
    employers: [{ ...baseEmployer, id: "employer-debug-test", company_name: "Debug Target", company_slug: "debug-target" }],
    jobs: [],
    ingestion_runs: [],
  };
  const { ingest } = freshIngest(tables);
  const realFetch = global.fetch;
  global.fetch = greenhouseFetchStub(3);
  const realArgv = process.argv;
  process.argv = [...realArgv.slice(0, 2), "Debug Target"];
  try {
    await ingest.run({ worker: async employer => {
      const measured = await require('./ingestRunMetrics').measure(() => ingest.ingestEmployer(employer));
      return { status: measured.result.status, metrics: measured.metrics, counts_complete: true };
    } });
  } finally {
    global.fetch = realFetch;
    process.argv = realArgv;
  }
  assert.equal(tables.jobs.length, 3, "a filtered single-employer run should still process that employer even though the lock row shows as held");
});

for (const ats_type of ['greenhouse', 'successfactors', 'workday', 'oraclehcm', 'phenom', 'pinpoint']) {
  test(`${ats_type} extraction failure preserves existing active jobs`, async () => {
    const employer = {...baseEmployer, ats_type, ats_identifier: ats_type === 'workday' ? 'x|wd1|site' : ats_type === 'oraclehcm' ? 'test.invalid|site' : 'test.invalid'};
    const tables = { employers: [employer], jobs: [{id:'existing',employer_id:employer.id,source_job_id:'old',status:'active'}] };
    const {ingest} = freshIngest(tables);
    const old = global.fetch;
    global.fetch = async () => {throw new Error('incomplete extraction');};
    try {await ingest.ingestEmployer(employer);} finally {global.fetch = old;}
    assert.equal(tables.jobs[0].status, 'active');
    assert.equal(tables.jobs.length, 1);
    assert.equal(tables.employers[0].sync_status, 'error');
  });
}
