#!/usr/bin/env node
// Check newly ingested jobs against LinkedIn guest job search and stamp
// high-confidence "not on LinkedIn" presence onto jobs.location_evidence.
//
// Usage:
//   node backend/scripts/checkLinkedInPresence.js --since-hours=24 --write
//   node backend/scripts/checkLinkedInPresence.js --ids=uuid1,uuid2 --write
//   node backend/scripts/checkLinkedInPresence.js --since-hours=24          # dry run
//
// Env:
//   LINKEDIN_PRESENCE_DELAY_MS  delay between searches (default 2000)
//   LINKEDIN_PRESENCE_LIMIT     max jobs per run (default 400)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const {
  checkJobPresence,
  mergePresenceIntoEvidence,
  presenceRecord,
} = require("../linkedinJobPresence");

function parseArgs(argv) {
  const args = {
    write: argv.includes("--write"),
    force: argv.includes("--force"),
    sinceHours: 24,
    limit: Number(process.env.LINKEDIN_PRESENCE_LIMIT || 400),
    delayMs: Number(process.env.LINKEDIN_PRESENCE_DELAY_MS || 2000),
    ids: null,
    out: null,
  };
  for (const a of argv) {
    if (a.startsWith("--since-hours=")) args.sinceHours = Number(a.split("=")[1]);
    if (a.startsWith("--limit=")) args.limit = Number(a.split("=")[1]);
    if (a.startsWith("--delay-ms=")) args.delayMs = Number(a.split("=")[1]);
    if (a.startsWith("--ids=")) args.ids = a.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (a.startsWith("--out=")) args.out = a.split("=")[1];
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJobs(supabase, args) {
  if (args.ids?.length) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, company_name, title_original, location_raw, city, state, first_seen_at, location_evidence")
      .in("id", args.ids);
    if (error) throw new Error(error.message);
    return data || [];
  }

  const since = new Date(Date.now() - args.sinceHours * 3600 * 1000).toISOString();
  const jobs = [];
  const pageSize = 100;
  let from = 0;
  while (jobs.length < args.limit) {
    const to = Math.min(from + pageSize - 1, args.limit - 1);
    const { data, error } = await supabase
      .from("jobs")
      .select("id, company_name, title_original, location_raw, city, state, first_seen_at, location_evidence")
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .gte("first_seen_at", since)
      .order("first_seen_at", { ascending: false })
      .range(from, to);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    // Skip jobs already checked in the last 20 hours unless --force / --ids
    for (const job of data) {
      const checkedAt = job.location_evidence?.linkedin_presence?.checked_at;
      if (!args.force && checkedAt && Date.now() - Date.parse(checkedAt) < 20 * 3600 * 1000) continue;
      jobs.push(job);
      if (jobs.length >= args.limit) break;
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return jobs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const jobs = await fetchJobs(supabase, args);
  console.log(`LinkedIn presence check: ${jobs.length} job(s) (write=${args.write})`);

  const results = [];
  const counts = { not_on_linkedin: 0, on_linkedin: 0, possible: 0, error: 0 };

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const presence = await checkJobPresence(job);
    const record = presenceRecord(presence);
    counts[record.status] = (counts[record.status] || 0) + 1;
    results.push({
      id: job.id,
      company: job.company_name,
      title: job.title_original,
      loc: job.location_raw || job.state || "",
      first_seen_at: job.first_seen_at,
      ...record,
    });

    const badge = record.status === "not_on_linkedin" || record.status === "possible" ? " BADGE" : "";
    console.log(
      `[${i + 1}/${jobs.length}] ${record.status}${badge} | ${job.company_name} | ${String(job.title_original || "").slice(0, 70)} | ${record.why}`
    );

    if (args.write) {
      const evidence = mergePresenceIntoEvidence(job.location_evidence, presence);
      const { error } = await supabase
        .from("jobs")
        .update({ location_evidence: evidence })
        .eq("id", job.id);
      if (error) {
        console.error(`  write failed for ${job.id}: ${error.message}`);
        record.write_error = error.message;
      } else {
        job.location_evidence = evidence;
      }
    }

    if (i < jobs.length - 1 && args.delayMs > 0) await sleep(args.delayMs);
  }

  console.log("\nSummary:", counts);
  const badgeExamples = results
    .filter((r) => r.status === "not_on_linkedin" || r.status === "possible")
    .slice(0, 20);
  if (badgeExamples.length) {
    console.log("\nBadge examples (not verified on LinkedIn):");
    for (const r of badgeExamples) {
      console.log(`- [${r.status}] ${r.company} — ${r.title} (${r.why})`);
    }
  }

  const outPath =
    args.out ||
    path.join("/tmp", `linkedin-presence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), counts, results }, null, 2));
  console.log(`\nWrote ${outPath}`);

  // Also copy under artifacts when available
  const artifactsDir = "/opt/cursor/artifacts";
  try {
    if (fs.existsSync(artifactsDir)) {
      const art = path.join(artifactsDir, "linkedin-presence-last-run.json");
      fs.writeFileSync(art, JSON.stringify({ generated_at: new Date().toISOString(), counts, badgeExamples, results }, null, 2));
      console.log(`Wrote ${art}`);
    }
  } catch (_) {
    /* optional */
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { parseArgs, fetchJobs };
