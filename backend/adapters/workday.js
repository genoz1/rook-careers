// Workday CXS (Career Site) API adapter
//
// Public, unauthenticated endpoint — no signup, no API key required. This
// is the same API that powers the search box on a company's own public
// Workday careers site, so it's meant to be called from outside code.
//
// NOTE: unlike the Greenhouse/Lever/Ashby adapters, this one has not been
// tested against a live Workday endpoint — the sandbox this was written in
// can't reach myworkdayjobs.com. It's built to Workday's well-documented
// public API shape, but treat the first real ingestion run against each
// new Workday employer as the real test.
//
// You need three pieces of information per employer, all visible in their
// careers site URL:
//   https://{tenant}.{wdNumber}.myworkdayjobs.com/{site}
//   e.g. https://idexx.wd1.myworkdayjobs.com/IDEXX
//        tenant = "idexx", wdNumber = "wd1", site = "IDEXX"
//
// Store all three in the employers.ats_identifier column as a single
// pipe-delimited string: "tenant|wdNumber|site"
//   e.g. "idexx|wd1|IDEXX"

function parseWorkdayIdentifier(identifier) {
  const parts = (identifier || "").split("|");
  const [tenant, wdNumber, site] = parts;
  if (!tenant || !wdNumber || !site) {
    throw new Error(
      `Malformed Workday ats_identifier "${identifier}" — expected "tenant|wdNumber|site", e.g. "idexx|wd1|IDEXX"`
    );
  }
  return { tenant, wdNumber, site };
}

/**
 * Fetch all currently published jobs for one employer's Workday site,
 * including full descriptions. Workday paginates in batches (20 by
 * default); this walks every page, then fetches each job's detail page
 * separately since the list endpoint doesn't include full descriptions.
 *
 * @param {string} identifier - "tenant|wdNumber|site", e.g. "idexx|wd1|IDEXX"
 */
async function fetchWorkdayJobs(identifier) {
  const { tenant, wdNumber, site } = parseWorkdayIdentifier(identifier);
  const baseUrl = `https://${tenant}.${wdNumber}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;

  const allPostings = [];
  const pageSize = 20;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const res = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: pageSize, offset, searchText: "" }),
    });
    if (!res.ok) {
      throw new Error(`Workday fetch failed for "${identifier}": ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    total = data.total ?? 0;
    allPostings.push(...(data.jobPostings || []));
    offset += pageSize;

    // Safety cap so a very large employer (or an unexpected API response)
    // can't loop forever.
    if (offset > 2000) break;
  }

  // Fetch full description for each job. One extra request per job — for
  // a large employer this can be a lot of requests; that's an acceptable
  // MVP tradeoff, but worth revisiting (e.g. only fetch detail for jobs
  // whose title already looks relevant) if it becomes slow in practice.
  const detailed = [];
  for (const posting of allPostings) {
    try {
      const detailRes = await fetch(`${baseUrl}${posting.externalPath}`);
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      detailed.push({ ...posting, detail });
    } catch {
      // Skip jobs whose detail fetch fails rather than aborting the whole run.
      continue;
    }
  }

  return detailed;
}

/**
 * Convert one raw Workday job (list entry + detail merged) into ROOK's
 * canonical job shape.
 */
function normalizeWorkdayJob(raw, employer) {
  const { tenant, wdNumber, site } = parseWorkdayIdentifier(employer.ats_identifier);
  const baseUrl = `https://${tenant}.${wdNumber}.myworkdayjobs.com/${site}`;
  const jobUrl = `${baseUrl}${raw.externalPath}`;
  const info = raw.detail?.jobPostingInfo || {};

  return {
    source_job_id: info.jobReqId || raw.bulletFields?.[0] || raw.externalPath,
    employer_id: employer.id,
    source_type: "workday",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: info.jobDescription || null,
    description_text: stripHtml(info.jobDescription || ""),
    location_raw: raw.locationsText || "",
    // Workday's list view only gives relative text ("Posted 3 Days Ago"),
    // not a real date — leaving this null rather than guessing.
    date_posted: null,
    status: "active",
    source_verified: true,
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = { fetchWorkdayJobs, normalizeWorkdayJob, parseWorkdayIdentifier };
