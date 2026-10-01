// Exercise the real public route handlers with an in-memory database adapter.
// Run: node --test backend/testPublicIndexing.js (no live credentials needed).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup(rows, { cap = 1000, failAt = Infinity, configured = true, resources = [] } = {}) {
  const handlers = {};
  const client = {
    from(table) {
      let filters = [], columns = "", offset = 0, end = cap - 1, limit = Infinity, order;
      const query = {
        select(value) { columns = value; return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        lte(key, value) { filters.push(row => row[key] != null && row[key] <= value); return this; },
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
        let selected = (table === "resource_articles" ? resources : rows).filter(row => filters.every(filter => filter(row)));
        if (order) selected.sort((a, b) => String(a[order]).localeCompare(String(b[order])));
        selected = selected.slice(offset, offset + Math.min(end - offset + 1, cap, limit));
        const data = selected.map(row => Object.fromEntries(columns.split(",").map(key => [key.trim(), row[key.trim()]])));
        return { data: single ? data[0] || null : data, error: null };
      }
      return query;
    },
  };
  const router = { use() {}, get(route, handler) { handlers[route] = handler; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "routes/publicPages.js"), "utf8"), {
    URLSearchParams,
    require(name) {
      if (name === "../seoInventory") return require("./seoInventory");
      if (name === "../seoCollections") return require("./seoCollections");
      if (name === "../pretrialProjection") return require("./pretrialProjection");
      if (name === "express") return { Router: () => router };
      if (name === "@supabase/supabase-js") return { createClient: () => client };
      if (name === "../routes/stripe") return { getTrialPeriodDays: () => 3 };
      if (name === "../jobEligibility") return { isUsEligibleJob: (job) => job.location_raw !== "Kuwait" };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: configured ? { SUPABASE_URL: "https://example.test", SUPABASE_ANON_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "server-test", PUBLIC_APP_URL: "https://rookcareers.com" } : {} },
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

test("public directory, sitemap, and direct job pages hide ineligible jobs", async () => {
  const rows = jobs(3);
  rows[1].location_raw = "Kuwait";
  const invoke = setup(rows);
  const directory = await invoke("/jobs");
  const sitemap = await invoke("/sitemap.xml");
  const hiddenDetail = await invoke("/jobs/:id", { params: { id: rows[1].id } });
  assert.ok(directory.body.includes(rows[0].id) && directory.body.includes(rows[2].id));
  assert.ok(!directory.body.includes(rows[1].id));
  assert.ok(sitemap.body.includes(rows[0].id) && sitemap.body.includes(rows[2].id));
  assert.ok(!sitemap.body.includes(rows[1].id));
  assert.equal(hiddenDetail.statusCode, 404);
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
  assert.ok(res.body.includes("Employer: 🔒 Hidden until free trial"));
  assert.ok(res.body.includes("complete job description"));
  assert.ok(!res.body.includes("&lt;script&gt;"), "original title is withheld, not escaped into metadata");
  assert.ok(res.body.includes("Tampa, FL"));
  assert.ok(!res.body.includes('<script>alert("x")</script>'));
});

 test("LinkedIn preview preserves the clicked job and campaign without leaking source fields", async () => {
  const row = {...jobs(1)[0], id:'9980b1fc-c214-4c65-9f3f-70d46e748be6', title_original:'Clinical Sales Manager (New York) PRIVATE_EMPLOYER BrandXYZ ReqSecret8842',city:'New York City',state:'NY',location_raw:'New York City, NY',employment_type:'Full-time',salary_min:118337,salary_max:177505,ai_analysis:{product_categories:['Diagnostics'],summary:'PRIVATE_FULL_DESCRIPTION BrandXYZ'}};
  const res = await setup([row])('/jobs/:id',{params:{id:row.id},query:{utm_source:'linkedin',utm_medium:'social',utm_campaign:'organic',ref:'linkedin-post'}});
  for (const value of ['Clinical Sales Manager (New York)','New York, NY','Full-time','$118,337–$177,505','Diagnostics','Start My 3-Day Free Trial','job='+row.id,'utm_source=linkedin','ref=linkedin-post']) assert.ok(res.body.includes(value),value);
  for (const value of ['PRIVATE_','BrandXYZ','ReqSecret8842','private-application','Browse current opportunities']) assert.ok(!res.body.includes(value),value);
 });

test("main sitemap includes only published Resources and picks up new articles automatically", async () => {
  const resources = Array.from({length: 7}, (_, i) => ({slug: 'guide-'+i, published_at:'2020-01-01T00:00:00Z', 'resource_topics.status':'published'}));
  resources.push({slug:'rejected',published_at:'2020-01-01T00:00:00Z','resource_topics.status':'rejected'},
    {slug:'draft',published_at:null,'resource_topics.status':'queued'},
    {slug:'future',published_at:'2999-01-01T00:00:00Z','resource_topics.status':'published'});
  const invoke=setup(jobs(3),{cap:2,resources});
  const first=await invoke('/sitemap.xml');assert.equal(first.statusCode,200);
  assert.ok(first.body.includes('<loc>https://rookcareers.com/resources/</loc>'));
  for(let i=0;i<7;i++)assert.ok(first.body.includes('/resources/guide-'+i+'/'));
  for(const slug of ['draft','rejected','future'])assert.ok(!first.body.includes('/resources/'+slug+'/'));
  assert.ok(first.body.includes('/jobs/job-00002'));
  resources.push({slug:'newly-published',published_at:'2020-01-01T00:00:00Z','resource_topics.status':'published'});
  assert.ok((await invoke('/sitemap.xml')).body.includes('/resources/newly-published/'));
});
