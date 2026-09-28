const assert=require('node:assert/strict');
const {allocateBudget}=require('./portfolio');
const controls=['meta:m','google:g','reddit:r'].map((key,i)=>({id:String(i),platform:key.split(':')[0],external_campaign_id:key.split(':')[1],desired_state:'active',approved_for_automation:true,min_daily_budget_cents:100,max_daily_budget_cents:1000}));
const campaigns=[
 {platform:'meta',external_campaign_id:'m',campaign_name:'Meta',status:'ACTIVE',daily_budget_cents:300,clicks:5,spend_cents:100},
 {platform:'google',external_campaign_id:'g',campaign_name:'Google',status:'ENABLED',budget_cents:300,budget_resource_name:'customers/1/campaignBudgets/1',clicks:2,spend_cents:100},
 {platform:'reddit',external_campaign_id:'r',campaign_name:'Reddit',status:'ACTIVE',daily_budget_cents:300,clicks:0,spend_cents:0},
];
const p=allocateBudget({budgetCents:1200,campaigns,controls});
assert.equal(p.ok,true);assert.equal(p.allocated_cents,1200);assert.equal(p.unallocated_cents,0);
assert.ok(p.campaigns[0].proposed_budget_cents>p.campaigns[1].proposed_budget_cents);
assert.ok(p.campaigns[1].proposed_budget_cents>p.campaigns[2].proposed_budget_cents);
assert.equal(p.campaigns[0].reason,'Yesterday’s clicks per dollar');
assert.match(p.campaigns[2].reason,/exploration share/);
assert.equal(p.campaigns.reduce((n,c)=>n+c.proposed_budget_cents,0),1200);
const fixed=allocateBudget({budgetCents:1200,campaigns,controls:controls.slice(1)});
assert.equal(fixed.ok,true);assert.equal(fixed.reserved_cents,300);
assert.equal(fixed.campaigns.find(c=>c.platform==='meta').proposed_budget_cents,300);
assert.equal(allocateBudget({budgetCents:200,campaigns,controls:controls.slice(1)}).ok,false);
assert.equal(allocateBudget({budgetCents:200,campaigns,controls}).ok,false);
assert.equal(allocateBudget({budgetCents:1200,campaigns:[...campaigns,campaigns[0]],controls}).ok,false);
assert.equal(allocateBudget({budgetCents:1200,campaigns:[{...campaigns[0],daily_budget_cents:null}],controls}).ok,false);
assert.equal(allocateBudget({budgetCents:1200,campaigns:[{...campaigns[1],budget_resource_name:null}],controls}).ok,false);
const capped=allocateBudget({budgetCents:5000,campaigns,controls});
assert.equal(capped.allocated_cents,3000);assert.equal(capped.unallocated_cents,2000);
const allNew=allocateBudget({budgetCents:600,campaigns:campaigns.map(c=>({...c,clicks:0,spend_cents:0})),controls});
assert.equal(allNew.allocated_cents,600);
console.log('Portfolio allocation tests passed');
