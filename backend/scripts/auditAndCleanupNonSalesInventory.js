#!/usr/bin/env node
// Audit active jobs for sales admission and optionally close confirmed
// non-sales contamination while preserving history.
//
// Usage:
//   node backend/scripts/auditAndCleanupNonSalesInventory.js --report
//   node backend/scripts/auditAndCleanupNonSalesInventory.js --apply --max-invalid-pct 35
//
// Never mass-closes ambiguous rows. Never treats incomplete evidence as proof.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { isSalesAdmissibleJob, titleHasStrongSalesSignal, isExcludedTitle } = require('../relevanceFilter');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const maxInvalidPct = Number((process.argv.find((a, i, all) => all[i - 1] === '--max-invalid-pct') || '35'));

function classifyRow(job) {
  const title = job.title_original || job.title_normalized || '';
  const description = job.description_text || job.description_html || '';
  if (isSalesAdmissibleJob({ title, description })) {
    return { bucket: 'A', reason: 'sales_admissible' };
  }
  if (isExcludedTitle(title) || (!titleHasStrongSalesSignal(title) && /\b(?:veterinar|surgeon|physician|nurse|technician|scientist|clinical specialist|practice manager|hospital manager|clinical study|clinical manager|\brn\b|clinical care transition|medical support specialist)\b/i.test(title))) {
    return { bucket: 'B', reason: 'confirmed_non_sales' };
  }
  return { bucket: 'C', reason: 'ambiguous' };
}

async function loadActiveJobs(db) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db.from('jobs')
      .select('id,title_original,title_normalized,company_name,employer_id,description_text,description_html,status,moderation_status,source_type')
      .eq('status', 'active')
      .eq('moderation_status', 'approved')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exitCode = 1;
    return;
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const jobs = await loadActiveJobs(db);
  const buckets = { A: [], B: [], C: [] };
  const byCompany = new Map();
  for (const job of jobs) {
    const result = classifyRow(job);
    buckets[result.bucket].push({ ...job, cleanup_reason: result.reason });
    const key = job.company_name || 'Unknown';
    const entry = byCompany.get(key) || { A: 0, B: 0, C: 0 };
    entry[result.bucket] += 1;
    byCompany.set(key, entry);
  }
  const total = jobs.length || 1;
  const invalidPct = (buckets.B.length / total) * 100;
  const focusCompanies = [
    'BluePearl', 'Arthrex', 'Ascend Clinical', 'EMD Serono', 'VetPlus',
    'Blue River PetCare', 'Antech',
  ];
  const focus = {};
  for (const name of focusCompanies) {
    focus[name] = [...buckets.A, ...buckets.B, ...buckets.C]
      .filter((j) => String(j.company_name || '').toLowerCase().includes(name.toLowerCase()))
      .map((j) => ({
        id: j.id,
        title: j.title_original,
        bucket: buckets.A.includes(j) ? 'A' : buckets.B.includes(j) ? 'B' : 'C',
      }));
  }
  const report = {
    inventory_before: jobs.length,
    confirmed_relevant: buckets.A.length,
    confirmed_irrelevant: buckets.B.length,
    ambiguous_retained: buckets.C.length,
    invalid_pct: Number(invalidPct.toFixed(2)),
    max_invalid_pct_gate: maxInvalidPct,
    apply,
    focus_employers: Object.fromEntries(Object.entries(focus).map(([k, v]) => [k, {
      count: v.length,
      irrelevant: v.filter((x) => x.bucket === 'B').length,
      sample: v.filter((x) => x.bucket === 'B').slice(0, 10),
    }])),
    top_irrelevant_companies: [...byCompany.entries()]
      .map(([company, counts]) => ({ company, ...counts }))
      .filter((row) => row.B > 0)
      .sort((a, b) => b.B - a.B)
      .slice(0, 25),
  };
  console.log('INVENTORY_AUDIT_REPORT', JSON.stringify(report, null, 2));

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to close confirmed irrelevant jobs.');
    return;
  }
  if (invalidPct > maxInvalidPct) {
    console.error(`Refusing cleanup: ${invalidPct.toFixed(1)}% invalid exceeds --max-invalid-pct=${maxInvalidPct}. Investigate classifier first.`);
    process.exitCode = 2;
    return;
  }
  const now = new Date().toISOString();
  let closed = 0;
  for (let i = 0; i < buckets.B.length; i += 200) {
    const batch = buckets.B.slice(i, i + 200);
    const { error } = await db.from('jobs').update({
      status: 'closed',
      updated_at: now,
      moderation_status: 'approved',
    }).in('id', batch.map((j) => j.id)).eq('status', 'active');
    if (error) throw error;
    closed += batch.length;
  }
  console.log('INVENTORY_CLEANUP_RESULT', JSON.stringify({
    inventory_before: jobs.length,
    invalid_closed: closed,
    ambiguous_retained: buckets.C.length,
    inventory_after_estimate: jobs.length - closed,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
