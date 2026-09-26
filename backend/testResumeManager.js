const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../public/rook-resume.html'),'utf8');
const code=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim()).join('\n');
function setup(initial){
 const elements=new Map(),requests=[];let resume=initial,fail=false,analysis='ok',statusIndex=0;const matchStatuses=['processing','complete'];
 const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',value:'',href:id==='viewUpdatedMatches'?'rook-dashboard.html':'',files:[],classList:{toggle(){}},addEventListener(event,fn){this[event]=fn;},removeAttribute(name){delete this[name];}});return elements.get(id);};
 const context={URL,Date,FormData:class{append(key,value){this[key]=value;}},setTimeout:fn=>{fn();},document:{getElementById:get},window:{addEventListener(){}},rookRequireAuth:async()=>true,rookApiFetch:async(url,options)=>{
  requests.push({url,options});if(url==='/resume'){if(fail)return{ok:false,json:async()=>({})};resume={filename:options.body.resume.name,url:'https://storage.example/owned-resume',uploaded_at:'2026-09-19T12:00:00Z'};return{ok:true,json:async()=>({ok:true,analysis_status:analysis})};}
  if(url==='/resume-status'){const status=matchStatuses[Math.min(statusIndex++,matchStatuses.length-1)];return{ok:true,json:async()=>({status})};}
  return{ok:true,json:async()=>resume};
 }};vm.runInNewContext(code,context);
 return{get,requests,ready:()=>new Promise(resolve=>setImmediate(resolve)),fail:()=>{fail=true;},partial:()=>{analysis='failed';},submit:()=>get('uploadForm').submit({preventDefault(){}})};
}
test('current document is shown with a private viewing link',async()=>{
 const s=setup({filename:'Current.pdf',url:'https://storage.example/owned-resume',uploaded_at:'2026-09-19T12:00:00Z'});await s.ready();
 assert.equal(s.get('filename').textContent,'Current.pdf');assert.equal(s.get('openResume').href,'https://storage.example/owned-resume');assert.equal(s.get('replaceTitle').textContent,'Replace your résumé');
});
test('empty account and invalid files cannot accidentally submit',async()=>{
 const s=setup(null);await s.ready();assert.equal(s.get('empty').hidden,false);
 for(const file of [{name:'wrong.exe',size:10},{name:'large.pdf',size:11*1024*1024}]){s.get('resumeFile').files=[file];await s.submit();}
 assert.equal(s.requests.filter(r=>r.url==='/resume').length,0);
});
test('replacement waits for confirmed persisted rescore and offers updated matches',async()=>{
 const s=setup(null);await s.ready();s.get('resumeFile').files=[{name:'Replacement.docx',size:100}];await s.submit();
 assert.equal(s.requests.filter(r=>r.url==='/resume').length,1);assert.equal(s.requests.filter(r=>r.url==='/resume-status').length,2);assert.equal(s.get('filename').textContent,'Replacement.docx');assert.match(s.get('status').textContent,/job matches have been refreshed/);assert.equal(s.get('viewUpdatedMatches').hidden,false);assert.equal(s.get('viewUpdatedMatches').href,'rook-dashboard.html');assert.equal(s.get('uploadButton').disabled,false);
});
test('failed upload keeps current document and partial analysis reports upload separately',async()=>{
 const s=setup({filename:'Current.pdf',url:'https://storage.example/owned-resume'});await s.ready();s.fail();s.get('resumeFile').files=[{name:'Replacement.pdf',size:100}];await s.submit();assert.equal(s.get('filename').textContent,'Current.pdf');assert.match(s.get('status').textContent,/did not complete/);
 const partial=setup(null);await partial.ready();partial.partial();partial.get('resumeFile').files=[{name:'New.pdf',size:100}];await partial.submit();assert.match(partial.get('status').textContent,/contents could not be analyzed/);assert.equal(partial.get('filename').textContent,'New.pdf');
});
