// Preview a single cross-platform daily budget. No platform writes here.
function allocateBudget({ budgetCents, campaigns, controls }) {
  if (!Number.isInteger(budgetCents) || budgetCents < 100) return { ok: false, error: 'Enter a daily budget of at least $1.00.' };
  const controlMap = new Map(controls.map(c => [`${c.platform}:${c.external_campaign_id}`, c]));
  const seen = new Set(), fixed = [], eligible = [];
  for (const c of campaigns) {
    const key = `${c.platform}:${c.external_campaign_id}`;
    if (seen.has(key)) return { ok: false, error: `Duplicate campaign ${key}; allocation blocked.` };
    seen.add(key);
    const active = ['active','enabled'].includes(String(c.effective_status || c.status || '').toLowerCase());
    if (!active) continue;
    const current = c.daily_budget_cents ?? c.budget_cents;
    if (!Number.isInteger(current) || current < 0) return { ok: false, error: `Current daily budget unavailable for ${key}; allocation blocked.` };
    if (c.platform === 'google' && !c.budget_resource_name) return { ok: false, error: `Google budget resource unavailable for ${key}; allocation blocked.` };
    const ctrl = controlMap.get(key);
    const item = { platform:c.platform, campaign_id:String(c.external_campaign_id), campaign_name:c.campaign_name, current_budget_cents:current,
      clicks:c.clicks, spend_cents:c.spend_cents, budget_resource_name:c.budget_resource_name, control_id:ctrl?.id };
    if (ctrl?.approved_for_automation && ctrl.desired_state === 'active') {
      item.min = ctrl.min_daily_budget_cents;
      item.max = ctrl.max_daily_budget_cents;
      if (!Number.isInteger(item.min) || !Number.isInteger(item.max) || item.min < 0 || item.max < item.min)
        return { ok:false, error:`Invalid limits for ${key}; allocation blocked.` };
      eligible.push(item);
    } else fixed.push({ ...item, proposed_budget_cents:current, reason:'Not approved for automatic allocation' });
  }
  const googleBudgets = new Set();
  for (const item of [...fixed,...eligible].filter(i => i.platform === 'google')) {
    if (googleBudgets.has(item.budget_resource_name)) return { ok:false, error:'A Google budget is shared by multiple campaigns; allocation blocked until those campaigns are handled together.' };
    googleBudgets.add(item.budget_resource_name);
  }
  const reserved = fixed.reduce((n,c) => n+c.current_budget_cents,0);
  const available = budgetCents - reserved;
  if (available < 0) return {ok:false,error:`Unapproved campaigns already total $${(reserved/100).toFixed(2)}, above the requested budget.`};
  const minimum = eligible.reduce((n,c) => n+c.min,0);
  if (minimum > available) return {ok:false,error:'Approved campaign minimums plus unapproved budgets exceed the requested daily amount.'};
  if (!eligible.length) return {ok:true,budget_cents:budgetCents,reserved_cents:reserved,allocated_cents:reserved,unallocated_cents:available,campaigns:fixed};
  const proven = eligible.filter(c => c.clicks > 0 && c.spend_cents > 0);
  const average = proven.length ? proven.reduce((n,c)=>n+c.clicks/c.spend_cents,0)/proven.length : 1;
  for (const c of eligible) {
    c.proposed_budget_cents = c.min;
    c.score = proven.includes(c) ? c.clicks/c.spend_cents : average*0.25;
    c.reason = proven.includes(c) ? 'Yesterday’s clicks per dollar' : 'No usable clicks and spend yesterday; exploration share';
  }
  let left = Math.min(available - minimum, eligible.reduce((n,c)=>n+c.max-c.min,0));
  while (left > 0) {
    const open = eligible.filter(c=>c.proposed_budget_cents < c.max);
    if (!open.length) break;
    const total = open.reduce((n,c)=>n+c.score,0);
    let assigned=0;
    for (const c of open) {
      const share = Math.min(c.max-c.proposed_budget_cents, Math.max(0, Math.floor(left*c.score/total)));
      c.proposed_budget_cents += share; assigned += share;
    }
    if (!assigned) { open.sort((a,b)=>b.score-a.score)[0].proposed_budget_cents++; assigned=1; }
    left-=assigned;
  }
  const rows = [...eligible.map(({min,max,score,...c})=>c),...fixed];
  const allocated = rows.reduce((n,c)=>n+c.proposed_budget_cents,0);
  return {ok:true,budget_cents:budgetCents,reserved_cents:reserved,allocated_cents:allocated,unallocated_cents:budgetCents-allocated,campaigns:rows};
}
module.exports = { allocateBudget };
