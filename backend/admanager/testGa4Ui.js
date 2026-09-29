const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('public/rook-admanager.html','utf8');
const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'today',textContent:'',innerHTML:'',style:{}});return nodes.get(id)};
const context={document:{getElementById:node,querySelector:()=>node('sub')},sessionStorage:{getItem:()=>null},console,Date,Number,String,Object,Set,encodeURIComponent};vm.createContext(context);vm.runInContext(html.split('<script>')[1].split('// ── Boot ──')[0],context);
const data={ok:true,property_id:'123',fetched_at:new Date().toISOString(),time_zone:'UTC',totals:{users:100,sessions:120,new_users:80},sign_up:40,stages:[{label:'Start',event:'v8_dashboard_impression',users:50,count:60},{label:'Signup',event:'v8_signup_started',users:10,count:12},{label:'Trial',event:'v8_trial_started',users:null,count:null}],traffic:[{source_medium:'google / cpc',campaign:'<script>bad</script>',sessions:50,users:40}],attributed_events:[],warnings:[]};
context.renderGa4(data);assert.match(node('ga4Body').innerHTML,/50.0% of previous/);assert.match(node('ga4Body').innerHTML,/20.0% of previous/);assert.match(node('ga4Body').innerHTML,/No data returned/);assert.ok(!node('ga4Body').innerHTML.includes('<script>bad'));data.totals.users=0;context.renderGa4(data);assert.ok(!/Infinity|NaN/.test(node('ga4Body').innerHTML));
(async()=>{
 for(const period of ['today','yesterday','7d']){
  node('periodSelect').value=period;let paths=[];
  context.api=async path=>{paths.push(path);if(path.startsWith('ga4'))throw new Error('GA4 failed');if(path.startsWith('dashboard'))return {period,platforms:{google:{ok:true,campaigns:[{external_campaign_id:'g',status:'ENABLED',spend_cents:100}]},meta:{ok:true,campaigns:[{external_campaign_id:'m',status:'ACTIVE',spend_cents:200}]}},fetched_at:new Date().toISOString()};return {budget:null};};
  await context.loadAll();assert.equal(node('s-spend').textContent,'$3.00');assert.equal(node('ga4Status').textContent,'Unavailable');assert.ok(paths.includes('ga4?period='+period));
 }
 let resolveOld;context.api=path=>path.includes('today')?new Promise(resolve=>resolveOld=resolve):Promise.resolve({...data,property_id:'new'});
 const old=context.loadGa4('today');await context.loadGa4('yesterday');resolveOld({...data,property_id:'old'});await old;assert.match(node('ga4Body').innerHTML,/Property new/);
 console.log('GA4 UI ratios, zero denominator, escaping, three periods, isolated failures and stale responses passed');
})().catch(e=>{console.error(e);process.exitCode=1});
