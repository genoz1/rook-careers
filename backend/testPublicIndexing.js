// Exercise the real public route handlers with an in-memory database adapter.
// Run: node --test backend/testPublicIndexing.js (no live credentials needed).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup(rows, { cap = 1000, failAt = Infinity, configured = true } = {}) {
  const handlers = {};
  const client = {
    from() {
      let filters = [], columns = "", offset = 0, end = cap - 1, limit = Infinity, order;
      const query = {
        select(value) { columns = value; return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        neq(key, value) { filters.push(row => row[key] !== value); return this; },
        ilike() { return this; },
        order(key) { order = key; return this; },
        range(start, stop) { offset = start; end = stop; return this; },
        limit(value) { limit = value; return this; },
        then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
        maybeSingle() { return Promise.resolve(result(true)); },
      };
      function result(single) {
        if (offset >= failAt) return { data: null, error: { message: "Database unavailable" } };
        let selected = rows.filter(row => filters.every(filter => filter(row)));
        if (order) selected.sort((a, b) => String(a[order]).localeCompare(String(b[order])));
        selected = selected.slice(offset, offset + Math.min(end - offset + 1, cap, limit));
        const data = selected.map(row => Object.fromEntries(columns.split(",").map(key => [key.trim(), row[key.trim()]])));
        return { data: single ? data[0] || null : data, error: null };
      }
      return query;
    },
  };
  const router = { get(route, handler) { handlers[route] = handler; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "routes/publicPages.js"), "utf8"), {
    require(name) {
      if (name === "express") return { Router: () => router };
      if (name === "@supabase/supabase-js") return { createClient: () => client };
      if (name === "../routes/stripe") return { getTrialPeriodDays: () => 3 };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: configured ? { SUPABASE_URL: "https://example.test", SUPABASE_ANON_KEY: "test", PUBLIC_APP_URL: "https://rookcareers.com" } : {} },
    module: { exports: {} },
  });
  return async (route, { query = {}, params = {} } = {}) => {
    const res = {
      statusCode: 200, headers: {}, body: "",
      status(code) { this.statusCode = code; return this; },
      set(key, value) { this.headers[key] = value; return this; },
      send(body) { this.body = body; return this; },
    };
    await handlers[route]({ query, params }, res, () => { throw new Error("Unexpected fallthrough"); });
    return res;
  };
}

const jobs = count => Array.from({ length: count }, (_, i) => ({
  id: `job-${String(i).padStart(5, "0")}`, title_original: `Sales role ${i}`,
  location_raw: "Tampa, FL", status: "active", moderation_status: "approved",
  company_name: "PRIVATE_EMPLOYER", description_text: "PRIVATE_FULL_DESCRIPTION",
  application_url: "https://private-application.example/", ai_analysis: {},
}));

test("sitemap includes more than 1,000 approved jobs despite a lower server response cap", async () => {
  const rows = jobs(1203);
  rows.push({ ...rows[0], id: "inactive", status: "closed" }, { ...rows[0], id: "pending", moderation_status: "pending" });
  const res = await setup(rows, { cap: 200 })("/sitemap.xml");
  assert.equal(res.statusCode, 200);
  assert.equal((res.body.match(/<loc>https:\/\/rookcareers.com\/jobs\/job-/g) || []).length, 1203);
  assert.ok(res.body.includes("job-01202"));
  assert.ok(!res.body.includes("/jobs/inactive") && !res.body.includes("/jobs/pending"));
  assert.ok(!res.body.includes("<lastmod>"));
  assert.ok(res.body.includes("<loc>https://rookcareers.com/jobs</loc>"));
});

test("sitemap failures return retryable errors rather than partial successful XML", async () => {
  for (const invoke of [setup(jobs(1203), { failAt: 500 }), setup([], { configured: false })]) {
    const res = await invoke("/sitemap.xml");
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["Retry-After"], "300");
    assert.ok(!res.body.includes("<urlset"));
  }
});

test("directory renders complete paginated links without disclosing paid fields", async () => {
  const invoke = setup(jobs(101));
  const first = await invoke("/jobs");
  const second = await invoke("/jobs", { query: { page: "2" } });
  assert.equal((first.body.match(/href="\/jobs\/job-/g) || []).length, 100);
  assert.equal((second.body.match(/href="\/jobs\/job-/g) || []).length, 1);
  assert.ok(first.body.includes('href="/jobs?page=2"'));
  assert.ok(second.body.includes('href="/jobs" class="btn btn-outline">Previous'));
  assert.ok(second.body.includes('rel="canonical" href="https://rookcareers.com/jobs?page=2"'));
  assert.ok(!second.body.includes("Next page"));
  for (const res of [first, second]) {
    assert.ok(!res.body.includes("PRIVATE_") && !res.body.includes("private-application"));
    assert.ok(res.body.includes("ROOK membership unlocks"));
  }
});

test("directory rejects nonexistent or malformed pages and handles database outages", async () => {
  const invoke = setup(jobs(1));
  for (const page of ["0", "-1", "1.5", "abc", ["1", "2"], "2"]) {
    assert.equal((await invoke("/jobs", { query: { page } })).statusCode, 404);
  }
  assert.equal((await setup([], { failAt: 0 })("/jobs")).statusCode, 503);
  assert.equal((await setup([], { configured: false })("/jobs")).statusCode, 503);
});

test("job previews use ordinary WebPage metadata, retain gates, and escape content", async () => {
  const row = { ...jobs(1)[0], title_original: 'Sales <script>alert("x")</script>', date_posted: null };
  const res = await setup([row])("/jobs/:id", { params: { id: row.id } });
  const json = res.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.equal(JSON.parse(json[1])["@type"], "WebPage");
  assert.equal(JSON.parse(json[1]).url, `https://rookcareers.com/jobs/${row.id}`);
  assert.ok(!res.body.includes('"@type":"JobPosting"'));
  assert.ok(!res.body.includes("PRIVATE_") && !res.body.includes("private-application"));
  assert.ok(res.body.includes("Employer revealed with ROOK access"));
  assert.ok(res.body.includes("ROOK members see the employer"));
  assert.ok(res.body.includes("&lt;script&gt;"));
  assert.ok(!res.body.includes('<script>alert("x")</script>'));
});
