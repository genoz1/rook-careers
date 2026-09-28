const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('public/rook-admanager.html','utf8');
const js=html.split('<script>')[1].split('// ── Boot ──')[0];
const nodes=new Map(); const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',style:{}});return nodes.get(id)};
let urls=[];
const context={document:{getElementById:node,querySelector:()=>node('conv-sub')},sessionStorage:{getItem:()=>null},console,Date,Number,String,Object,Set,encodeURIComponent,
 fetch:async url=>{urls.push(url);if(url.includes('/dashboard?'))return {ok:true,status:200,json:async()=>({period:new URL(url,'https://rookcareers.com').searchParams.get('period'),platforms:{meta:{ok:true,campaigns:[{external_campaign_id:'m',status:'ACTIVE',spend_cents:123,impressions:10,clicks:2,conversions:1}]}},fetched_at:new Date().toISOString()})};return {ok:true,status:200,json:async()=>({budget:null})}}};
vm.createContext(context);vm.runInContext(js,context);
(async()=>{
 vm.runInContext("token='secret'",context);
 for(const period of ['today','yesterday','7d']){
  node('periodSelect').value=period;urls=[];await context.loadAll();
  const u=new URL(urls[0],'https://rookcareers.com');
  assert.equal(u.pathname,'/api/admin/admanager/dashboard');
  assert.equal(u.searchParams.get('period'),period);
  assert.equal(u.searchParams.get('token'),'secret');
  assert.equal(node('s-spend').textContent,'$1.23');
  assert.match(node('overviewTable').innerHTML,/\$1\.23/);
 }
 context.fetch=async()=>({ok:false,status:503,json:async()=>({error:'Platform unavailable'})});
 await context.loadAll();
 assert.match(node('overviewTs').textContent,/Platform unavailable/);
 assert.equal(node('s-spend').textContent,'—');
 console.log('Dashboard URL and failure tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
