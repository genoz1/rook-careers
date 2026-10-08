#!/usr/bin/env node
// Deactivate blocked pet-retail employers (e.g. mislabeled "Vet Receptionists"
// → Petco) and close their active jobs so they leave member feeds immediately.
//
// Usage:
//   node backend/scripts/cleanupBlockedRetailEmployers.js --report
//   node backend/scripts/cleanupBlockedRetailEmployers.js --apply
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { blockedEmployerReason } = require('../employerSourcePolicy');

const apply = process.argv.includes('--apply');

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exitCode = 1;
    return;
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: employers, error } = await db.from('employers').select('*');
  if (error) throw error;

  const blocked = (employers || [])
    .map((employer) => ({ employer, reason: blockedEmployerReason(employer) }))
    .filter((row) => row.reason);

  console.log(`Blocked employers matched: ${blocked.length}`);
  for (const { employer, reason } of blocked) {
    const { count } = await db.from('jobs').select('id', { count: 'exact', head: true })
      .eq('employer_id', employer.id).eq('status', 'active');
    console.log(`- ${employer.company_name} (${employer.id}) active_jobs=${count} reason=${reason}`);
  }

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to deactivate employers and close jobs.');
    return;
  }

  const closedAt = new Date().toISOString();
  for (const { employer, reason } of blocked) {
    const { error: empErr } = await db.from('employers').update({
      active: false,
      ingestion_hold_reason: reason,
      sync_status: 'error',
      last_checked_at: closedAt,
      updated_at: closedAt,
    }).eq('id', employer.id);
    if (empErr) throw empErr;

    // Page closes so PostgREST row limits cannot leave retail jobs active.
    for (;;) {
      const { data: batch, error: listErr } = await db.from('jobs')
        .select('id')
        .eq('employer_id', employer.id)
        .eq('status', 'active')
        .limit(500);
      if (listErr) throw listErr;
      if (!batch?.length) break;
      const { error: closeErr } = await db.from('jobs').update({
        status: 'closed',
        updated_at: closedAt,
        moderation_status: 'rejected',
      }).in('id', batch.map((j) => j.id));
      if (closeErr) throw closeErr;
      console.log(`  closed ${batch.length} jobs for ${employer.company_name}`);
    }

    if (employer.discovery_candidate_id) {
      await db.from('discovery_candidates').update({
        status: 'unresolved',
        last_error: reason,
        validation_status: 'BLOCKED_EMPLOYER_SOURCE',
        updated_at: closedAt,
      }).eq('id', employer.discovery_candidate_id);
    }
  }
  console.log('Apply complete.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
