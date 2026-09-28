const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('public/rook-admanager.html','utf8');
const js=html.split('<script>')[1].split('// ── Boot ──')[0];
const nodes=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',style:{}});return nodes.get(id)};
const context={document:{getElementById:node,querySelector:()=>node('conv-sub')},sessionStorage:{getItem:()=>null},console,Date,Number,String,Object,Set,encodeURIComponent};
vm.createContext(context);vm.runInContext(js,context);
const campaign=(id,status,spend,impressions,clicks,conversions)=>({external_campaign_id:id,campaign_name:id,status,effective_status:status,spend_cents:spend,impressions,clicks,conversions,conversion_label:'Google Ads conversions'});
for(const [period,spend] of [['today',100],['yesterday',250],['7d',600]]){
 const data={period,mode:'off',fetched_at:new Date().toISOString(),platforms:{google:{ok:true,campaigns:[campaign('paused','PAUSED',0,0,0,0),campaign('running','ENABLED',spend,100,5,1),campaign('zero','ENABLED',0,0,0,0),campaign('running','ENABLED',spend,100,5,1)]},reddit:{ok:false,error:'report unavailable',campaigns:[]}}};
 context.renderOverview(data);
 assert.equal(node('s-spend').textContent,'$'+(spend/100).toFixed(2));
 assert.equal(node('s-active').textContent,2);
 assert.ok(node('overviewTable').innerHTML.indexOf('running')<node('overviewTable').innerHTML.indexOf('paused'));
 assert.match(node('overviewTable').innerHTML,/20\.00%|5\.00%/);
 assert.match(node('overviewTable').innerHTML,/—/);
 assert.ok(node('alertsBanner').innerHTML.includes('report unavailable'));
 assert.equal(node('alertsSection').style.display,'');
 assert.ok(html.indexOf('id="campaignCards"')<html.indexOf('id="alertsSection"'));
 assert.match(node('campaignCards').innerHTML,/Cost\/Conversion/);
}
console.log('Overview render tests passed');
