#!/usr/bin/env node
// One-shot pass over active employers that have never been checked.
// Uses the same recoverEmployer + deadline path as the scheduled job, with
// fair per-employer caps so one giant Workday board cannot starve the rest.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { recoverEmployer } = require('../ingestionRecovery');
const { boundedEmployer } = require('../ingestDeadline');
const { orderEmployersForIngest, employerTimeBudgetMs, EXPENSIVE_ATS } = require('../ingestScheduling');

const BUDGET_MS = Number(process.env.ROOK_NEVER_CHECKED_BUDGET_MS || 18 * 60 * 1000);

async function loadPending(db) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('employers')
      .select('*')
      .eq('active', true)
      .is('last_checked_at', null)
      .range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  // Prefer cheap ATS first inside the never-checked set so giant Workday
  // tenants cannot monopolize the first-check backlog pass.
  const cheap = rows.filter((e) => !EXPENSIVE_ATS.has(String(e.ats_type || '').toLowerCase()));
  const expensive = rows.filter((e) => EXPENSIVE_ATS.has(String(e.ats_type || '').toLowerCase()));
  return orderEmployersForIngest([...cheap, ...expensive]);
}

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const started = Date.now();
  const pending = await loadPending(db);
  console.log('PENDING_START', pending.length);
  const results = [];
  for (let index = 0; index < pending.length; index++) {
    const elapsedMs = Date.now() - started;
    const remaining = BUDGET_MS - elapsedMs;
    if (remaining < 5000) {
      console.log('LOCAL_BUDGET_STOP');
      break;
    }
    const employer = pending[index];
    const neverSyncedRemaining = pending.length - index;
    const timeoutMs = employerTimeBudgetMs(employer, remaining, { neverSyncedRemaining, elapsedMs });
    const t0 = Date.now();
    try {
      const result = await recoverEmployer(employer, timeoutMs, boundedEmployer);
      if (['timeout', 'failed'].includes(result.status)) {
        await db.from('employers').update({
          sync_status: 'error',
          last_checked_at: new Date().toISOString(),
        }).eq('id', employer.id);
      }
      const row = {
        name: employer.company_name,
        ats: employer.ats_type,
        status: result.status || 'ok',
        ms: Date.now() - t0,
        timeout_ms: timeoutMs,
        error: result.error || null,
        skip: result.skip_reason || null,
      };
      results.push(row);
      console.log('DONE', JSON.stringify(row));
    } catch (error) {
      await db.from('employers').update({
        sync_status: 'error',
        last_checked_at: new Date().toISOString(),
      }).eq('id', employer.id);
      const row = {
        name: employer.company_name,
        ats: employer.ats_type,
        status: 'threw',
        ms: Date.now() - t0,
        timeout_ms: timeoutMs,
        error: error.message,
      };
      results.push(row);
      console.log('FAIL', JSON.stringify(row));
    }
  }
  const by = {};
  for (const row of results) by[row.status] = (by[row.status] || 0) + 1;
  console.log('PENDING_SUMMARY', JSON.stringify({
    attempted: results.length,
    of: pending.length,
    by,
    elapsed_s: (Date.now() - started) / 1000,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
