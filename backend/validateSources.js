// ROOK Careers — read-only production source validator
//
// Exercises ROOK's REAL adapter fetch + normalize functions against live
// employer sources, WITHOUT touching the database. This file intentionally
// never imports @supabase/supabase-js and never requires backend/ingest.js
// (which creates a writable service-role Supabase client at module load
// time, unconditionally — importing it here would be exactly the mistake
// this tool exists to avoid). See README's "How read-only is guaranteed"
// section for the full reasoning, and backend/testSourceValidator.js for a
// test that asserts no supabase client is ever constructed.
//
// The dispatch table below intentionally mirrors backend/ingest.js's
// ats_type -> {fetch, normalize} switch (lines ~50-140 as of Round 3). It
// is NOT a duplicate of any adapter's extraction/normalization logic —
// every fetch*Jobs/normalize*Job function is imported and called exactly
// as ingest.js calls it. Only the routing itself is mirrored, because
// ingest.js does not export that dispatch as a standalone function and
// splitting it out would mean editing production ingestion code to serve
// a read-only tool, which is a larger change than necessary. Keep this in
// sync with ingest.js if a new ats_type is added — testSourceValidator.js
// checks the two ats_type lists against each other for exactly this reason.
//
// Usage:
//   npm run validate-sources -- --company "TG Therapeutics"
//   npm run validate-sources -- --batch 1
//   npm run validate-sources -- --all

const fs = require("fs");
const path = require("path");

const { fetchGreenhouseJobs, normalizeGreenhouseJob } = require("./adapters/greenhouse");
const { fetchWorkdayJobs, normalizeWorkdayJob } = require("./adapters/workday");
const { fetchWorkableJobs, normalizeWorkableJob } = require("./adapters/workable");
const { fetchClinchTalentJobs, normalizeClinchTalentJob } = require("./adapters/clinchtalent");
const { fetchOracleHcmJobs, normalizeOracleHcmJob } = require("./adapters/oraclehcm");
const { fetchPhenomJobs, normalizePhenomJob } = require("./adapters/phenom");
const { fetchApplicantProJobs, normalizeApplicantProJob } = require("./adapters/applicantpro");
const { fetchPinpointJobs, normalizePinpointJob } = require("./adapters/pinpoint");
const { fetchAdpJobs } = require("./adapters/adp");
const { fetchUkgJobs } = require("./adapters/ukg");
const { fetchSuccessFactorsJobs, normalizeSuccessFactorsJob } = require("./adapters/successfactors");
const { fetchCustomHtmlJobs, normalizeCustomHtmlJob, splitTerritoryOpenings } = require("./adapters/customHtml");

// Adapters whose fetch function itself only returns an empty array after
// finding POSITIVE evidence the employer genuinely has zero openings right
// now (an explicit "no results" text match, or — for custom_html — the
// page's own emptyConfirmed signal) — see each adapter's Round 1-3 refresh-
// safety fix. Any other adapter resolving to zero rows has no such
// built-in evidence and must be treated as suspicious by this validator.
const ADAPTERS_WITH_EXPLICIT_EMPTY_EVIDENCE = new Set(["successfactors", "clinchtalent", "applicantpro", "custom_html"]);

// Mirrors ingest.js's ats_type dispatch. Exported so
// testSourceValidator.js can check its keys against ingest.js's own list.
async function dispatch(employer) {
  switch (employer.atsType) {
    case "custom_html": {
      let rawJobs = await fetchCustomHtmlJobs(employer.__asIngestEmployer());
      if (employer.specialSettings?.splitTerritories) rawJobs = splitTerritoryOpenings(rawJobs);
      return { rawJobs, normalize: (job) => normalizeCustomHtmlJob(job, employer.__asIngestEmployer()) };
    }
    case "greenhouse":
      return {
        rawJobs: await fetchGreenhouseJobs(employer.atsIdentifier),
        normalize: (job) => normalizeGreenhouseJob(job, employer.__asIngestEmployer()),
      };
    case "workday":
      return {
        rawJobs: await fetchWorkdayJobs(employer.atsIdentifier),
        normalize: (job) => normalizeWorkdayJob(job, employer.__asIngestEmployer()),
      };
    case "workable":
      return {
        rawJobs: await fetchWorkableJobs(employer.atsIdentifier),
        normalize: (job) => normalizeWorkableJob(job, employer.__asIngestEmployer()),
      };
    case "clinchtalent":
      return {
        rawJobs: await fetchClinchTalentJobs(employer.atsIdentifier),
        normalize: (job) => normalizeClinchTalentJob(job, employer.__asIngestEmployer()),
      };
    case "oraclehcm":
      return {
        rawJobs: await fetchOracleHcmJobs(employer.atsIdentifier),
        normalize: (job) => normalizeOracleHcmJob(job, employer.__asIngestEmployer()),
      };
    case "phenom":
      return {
        rawJobs: await fetchPhenomJobs(employer.atsIdentifier),
        normalize: (job) => normalizePhenomJob(job, employer.__asIngestEmployer()),
      };
    case "applicantpro":
      return {
        rawJobs: await fetchApplicantProJobs(employer.atsIdentifier),
        normalize: (job) => normalizeApplicantProJob(job, employer.__asIngestEmployer()),
      };
    case "pinpoint":
      return {
        rawJobs: await fetchPinpointJobs(employer.atsIdentifier),
        normalize: (job) => normalizePinpointJob(job, employer.__asIngestEmployer()),
      };
    case "adp":
      return { rawJobs: await fetchAdpJobs(employer.__asIngestEmployer()), normalize: (job) => job };
    case "ukg":
      return { rawJobs: await fetchUkgJobs(employer.__asIngestEmployer()), normalize: (job) => job };
    case "successfactors": {
      const host = employer.atsIdentifier.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return {
        rawJobs: await fetchSuccessFactorsJobs(employer.atsIdentifier),
        normalize: (job) => normalizeSuccessFactorsJob(job, employer.__asIngestEmployer(), host),
      };
    }
    default:
      throw new Error(`No adapter for ats_type "${employer.atsType}" — cannot validate`);
  }
}
// The exact set of ats_type values this validator's dispatch knows about —
// checked against ingest.js's own switch by testSourceValidator.js.
dispatch.KNOWN_ATS_TYPES = [
  "custom_html", "greenhouse", "workday", "workable", "clinchtalent",
  "oraclehcm", "phenom", "applicantpro", "pinpoint", "adp", "ukg", "successfactors",
];

function loadManifest(manifestPath = path.join(__dirname, "sourceValidationManifest.json")) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return raw.candidates.map((c) => ({
    ...c,
    // A minimal object matching what each adapter's normalize()/fetch()
    // function actually reads off "employer" (id, company_name,
    // company_website, careers_url, industry, ats_type, ats_identifier).
    // Built fresh per candidate rather than read from the database — this
    // tool's whole point is to not need a DB connection to validate.
    __asIngestEmployer() {
      return {
        id: c.existingUuid || `validate:${c.companyName}`,
        company_name: c.companyName,
        company_website: c.companyWebsite,
        careers_url: c.careersUrl,
        industry: c.industry,
        ats_type: c.atsType,
        ats_identifier: c.atsIdentifier,
      };
    },
  }));
}

function redact(value) {
  // Defense in depth: nothing in this manifest or these adapters' return
  // values is expected to carry secrets, but any string that looks like a
  // bearer token / API key / basic-auth credential is redacted before it
  // can reach the output files, in case a future adapter's raw response
  // ever echoes a request header back.
  if (typeof value !== "string") return value;
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, "$1[REDACTED]")
    .replace(/([?&](?:api_key|token|access_token|password)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/(Authorization["']?\s*[:=]\s*["']?)[^"'\s,}]{10,}/gi, "$1[REDACTED]");
}

function summarizeLocation(job) {
  const raw = job.location_raw || job.location || "";
  return redact(String(raw));
}

async function validateOne(candidate) {
  const started = Date.now();
  const result = {
    company: candidate.companyName,
    recordAction: candidate.recordAction,
    existingUuid: candidate.existingUuid,
    atsType: candidate.atsType,
    atsIdentifier: candidate.atsIdentifier,
    careersUrl: candidate.careersUrl,
    previousStatus: candidate.previousStatus,
    status: null,
    elapsedMs: null,
    rawJobCount: null,
    normalizedJobCount: null,
    duplicateCount: 0,
    missingTitle: 0,
    missingLocation: 0,
    missingSourceUrl: 0,
    missingDescription: 0,
    remoteOrHybridCount: 0,
    multiLocationCount: 0,
    normalizationErrors: [],
    sampleJobs: [],
    error: null,
  };

  let rawJobs, normalize;
  try {
    ({ rawJobs, normalize } = await dispatch(candidate));
  } catch (err) {
    // dispatch() throws for two different reasons, and the two need
    // different statuses so a reviewer knows whether the problem is
    // "couldn't reach/read the source at all" (FAIL_SOURCE) or "reached it,
    // but couldn't find/parse the job listing content on the page"
    // (FAIL_EXTRACTION). Adapters don't currently throw typed errors, so
    // this classifies by message shape — every adapter's own refresh-safety
    // fix (Round 1-3) uses consistent wording for each case: network/HTTP
    // failures say "fetch failed"/mention a status code; shape/parse
    // failures talk about missing job links, fields, or an unexpected
    // response shape. Anything that doesn't match either pattern is left as
    // FAIL_SOURCE (the safer default — "couldn't confirm we ever got usable
    // content back") rather than guessed into FAIL_EXTRACTION.
    const msg = err.message || "";
    const looksLikeExtractionFailure =
      /no job links|no results found|unexpected response shape|no jobs field|could not (?:find|parse|locate)|missing (?:field|jobs)|malformed/i.test(msg);
    const looksLikeSourceFailure =
      /fetch failed|failed to fetch|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|status \d|HTTP \d|non-ok|returned \d+|timed? ?out/i.test(msg);
    result.status = looksLikeExtractionFailure && !looksLikeSourceFailure ? "FAIL_EXTRACTION" : "FAIL_SOURCE";
    result.error = redact(err.message);
    result.elapsedMs = Date.now() - started;
    return result;
  }

  result.rawJobCount = rawJobs.length;

  if (rawJobs.length === 0) {
    result.elapsedMs = Date.now() - started;
    if (ADAPTERS_WITH_EXPLICIT_EMPTY_EVIDENCE.has(candidate.atsType)) {
      result.status = "PASS_LIVE";
      result.normalizedJobCount = 0;
      result.warning = "Zero jobs, but this adapter only returns empty after confirming explicit no-results evidence (see its refresh-safety fix) — treated as legitimate.";
    } else {
      result.status = "FAIL_SUSPICIOUS_EMPTY";
      result.warning = `Zero jobs returned and "${candidate.atsType}" has no built-in explicit-empty-evidence check — cannot confirm this is a genuine zero-opening employer rather than a blocked/broken fetch. Needs manual inspection before treating as legitimate.`;
    }
    return result;
  }

  const normalized = [];
  for (const raw of rawJobs) {
    try {
      normalized.push(normalize(raw));
    } catch (err) {
      result.normalizationErrors.push(redact(err.message));
    }
  }

  result.elapsedMs = Date.now() - started;
  result.normalizedJobCount = normalized.length;

  if (normalized.length === 0) {
    result.status = "FAIL_NORMALIZATION";
    return result;
  }

  const seenIds = new Set();
  for (const job of normalized) {
    const id = job.source_job_id;
    if (id && seenIds.has(id)) result.duplicateCount++;
    if (id) seenIds.add(id);
    if (!job.title_original && !job.title) result.missingTitle++;
    if (!job.location_raw && !job.location) result.missingLocation++;
    if (!job.source_url && !job.url) result.missingSourceUrl++;
    if (!job.description_text && !job.description_html) result.missingDescription++;
    if (job.remote_status) result.remoteOrHybridCount++;
    const territories = job.extraction_evidence?.territories || job.territory;
    if (Array.isArray(territories) ? territories.length > 1 : (job.location_raw || "").includes(" | ")) {
      result.multiLocationCount++;
    }
  }

  result.sampleJobs = normalized.slice(0, 4).map((job) => ({
    title: redact(job.title_original || job.title || "(missing title)"),
    location: summarizeLocation(job),
    territory: job.extraction_evidence?.territories?.map((t) => t.label).join(" | ") || null,
    viewOriginalUrl: redact(job.source_url || job.url || "(missing)"),
    applicationDestination:
      job.application_url && job.application_url !== (job.source_url || job.url) ? redact(job.application_url) : null,
  }));

  if (result.normalizationErrors.length > 0) {
    result.status = "PASS_WITH_WARNINGS";
  } else if (result.missingTitle > 0 || result.missingSourceUrl > 0) {
    result.status = "FAIL_INCOMPLETE";
  } else if (result.missingLocation > normalized.length / 2) {
    // More than half the batch has no location at all — a real, known
    // limitation for some adapters (clinchtalent.js, see manifest note),
    // not a hard failure, but flagged loudly rather than passed silently.
    result.status = "PASS_WITH_WARNINGS";
    result.warning = `${result.missingLocation}/${normalized.length} jobs have no location_raw at all.`;
  } else {
    result.status = "PASS_LIVE";
  }

  return result;
}

function parseArgs(argv) {
  const args = { company: null, batch: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--company") args.company = argv[++i];
    else if (argv[i] === "--batch") args.batch = Number(argv[++i]);
    else if (argv[i] === "--all") args.all = true;
  }
  return args;
}

function selectCandidates(manifest, args) {
  if (args.company) {
    const match = manifest.filter((c) => c.companyName.toLowerCase() === args.company.toLowerCase());
    if (match.length === 0) throw new Error(`Unknown company "${args.company}" — not in sourceValidationManifest.json`);
    return match;
  }
  if (args.batch != null && !Number.isNaN(args.batch)) {
    const match = manifest.filter((c) => c.batch === args.batch);
    if (match.length === 0) throw new Error(`No candidates found for batch ${args.batch}`);
    return match;
  }
  if (args.all) return manifest;
  throw new Error('Specify one of: --company "<name>", --batch <n>, or --all');
}

function writeOutputs(rawResults, outDir = __dirname) {
  // Defense in depth: validateOne() already redacts error/normalization-
  // error strings before they land in its result object, but this second
  // pass re-redacts every free-text field right before it's written to
  // disk, so a result object built or edited some other way (e.g. a future
  // caller, or a test) still can't leak a secret-shaped string into the
  // two output files.
  const results = rawResults.map((r) => ({
    ...r,
    error: r.error != null ? redact(String(r.error)) : r.error,
    warning: r.warning != null ? redact(String(r.warning)) : r.warning,
    normalizationErrors: Array.isArray(r.normalizationErrors) ? r.normalizationErrors.map((e) => redact(String(e))) : r.normalizationErrors,
  }));
  const timestamp = new Date().toISOString();
  const meta = {
    timestamp,
    node: process.version,
    platform: process.platform,
    readOnly: true,
    note: "This tool never constructs a Supabase client and never calls backend/ingest.js. No database was read or written to produce these results.",
  };
  const jsonPath = path.join(outDir, "validation-results.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, results }, null, 2));

  const lines = [];
  lines.push(`# ROOK Source Validation Results`);
  lines.push("");
  lines.push(`Generated: ${timestamp} (Node ${process.version}, ${process.platform}). Read-only — no database access.`);
  lines.push("");
  lines.push("| Company | Status | ATS | Raw | Normalized | Dup | Missing Title | Missing Loc | Missing URL | Elapsed (ms) |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.company} | ${r.status} | ${r.atsType} | ${r.rawJobCount ?? "-"} | ${r.normalizedJobCount ?? "-"} | ${r.duplicateCount} | ${r.missingTitle} | ${r.missingLocation} | ${r.missingSourceUrl} | ${r.elapsedMs} |`
    );
  }
  lines.push("");
  for (const r of results) {
    lines.push(`## ${r.company} — ${r.status}`);
    lines.push(`- ats_type: \`${r.atsType}\`, ats_identifier: \`${r.atsIdentifier || "(none)"}\``);
    lines.push(`- record action: ${r.recordAction}${r.existingUuid ? ` (UUID: ${r.existingUuid})` : ""}`);
    if (r.error) lines.push(`- **error**: ${r.error}`);
    if (r.warning) lines.push(`- **warning**: ${r.warning}`);
    if (r.normalizationErrors?.length) lines.push(`- normalization errors: ${r.normalizationErrors.length} (${r.normalizationErrors.slice(0, 3).join("; ")})`);
    if (r.sampleJobs?.length) {
      lines.push(`- sample jobs:`);
      for (const j of r.sampleJobs) {
        lines.push(`  - **${j.title}** — ${j.location || "(no location)"}${j.territory ? ` [territory: ${j.territory}]` : ""}`);
        lines.push(`    View Original: ${j.viewOriginalUrl}${j.applicationDestination ? ` | Apply: ${j.applicationDestination}` : ""}`);
      }
    }
    lines.push("");
  }
  const mdPath = path.join(outDir, "validation-results.md");
  fs.writeFileSync(mdPath, lines.join("\n"));

  return { jsonPath, mdPath };
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = loadManifest();
  const candidates = selectCandidates(manifest, args);

  console.log(`ROOK source validator — READ-ONLY (no database access). ${candidates.length} candidate(s) to check.\n`);

  const results = [];
  for (const candidate of candidates) {
    process.stdout.write(`Validating ${candidate.companyName} (${candidate.atsType})... `);
    const result = await validateOne(candidate);
    console.log(`${result.status} (${result.elapsedMs}ms, raw=${result.rawJobCount ?? "-"}, normalized=${result.normalizedJobCount ?? "-"})`);
    if (result.error) console.log(`  error: ${result.error}`);
    if (result.warning) console.log(`  warning: ${result.warning}`);
    results.push(result);
    // One employer's failure never stops the batch — continue regardless
    // of this result's status.
  }

  const { jsonPath, mdPath } = writeOutputs(results);
  console.log(`\nWrote ${jsonPath}\nWrote ${mdPath}`);
  return results;
}

module.exports = { dispatch, loadManifest, validateOne, parseArgs, selectCandidates, writeOutputs, redact, run, ADAPTERS_WITH_EXPLICIT_EMPTY_EVIDENCE };

if (require.main === module) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
