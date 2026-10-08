const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../public/rook-resume.html'),'utf8');
const code=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim()).join('\n');
function setup(initial,{search='?' }={}){
 const elements=new Map(),requests=[],timeouts=[];let resume=initial,fail=false,analysis='ok';
 const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',value:'',href:id==='viewUpdatedMatches'?'rook-dashboard.html':'',files:[],classList:{toggle(){}},addEventListener(event,fn){this[event]=fn;},removeAttribute(name){delete this[name];}});return elements.get(id);};
 const location={href:'rook-resume.html',search};
 const context={URL,URLSearchParams,Date,FormData:class{append(key,value){this[key]=value;}},setTimeout:(fn,ms)=>{timeouts.push({fn,ms});},document:{getElementById:get},location,window:{addEventListener(){},location},rookRequireAuth:async()=>true,rookApiFetch:async(url,options)=>{
  requests.push({url,options});if(url==='/resume'){if(fail)return{ok:false,json:async()=>({})};resume={filename:options.body.resume.name,url:'https://storage.example/owned-resume',uploaded_at:'2026-09-19T12:00:00Z'};return{ok:true,json:async()=>({ok:true,analysis_status:analysis})};}
  return{ok:true,json:async()=>resume};
 }};vm.runInNewContext(code,context);
 return{get,requests,timeouts,ready:()=>new Promise(resolve=>setImmediate(resolve)),fail:()=>{fail=true;},partial:()=>{analysis='failed';},submit:()=>get('uploadForm').submit({preventDefault(){}})};
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
test('successful analysis returns to the dashboard without waiting on resume-status',async()=>{
 const s=setup(null);await s.ready();s.get('resumeFile').files=[{name:'Replacement.docx',size:100}];await s.submit();
 assert.equal(s.requests.filter(r=>r.url==='/resume').length,1);
 assert.equal(s.requests.filter(r=>r.url==='/resume-status').length,0);
 assert.equal(s.get('filename').textContent,'Replacement.docx');
 assert.match(s.get('status').textContent,/Taking you back to your job matches/);
 assert.equal(s.get('viewUpdatedMatches').hidden,false);
 assert.equal(s.get('viewUpdatedMatches').href,'rook-dashboard.html');
 assert.equal(s.timeouts.length,1);
 assert.ok(s.timeouts[0].ms<=1500);
 s.timeouts[0].fn();
 assert.equal(s.get('uploadButton').disabled,false);
});
test('V8 resume page redirects to the V8 dashboard',async()=>{
 const elements=new Map(),timeouts=[];let resume=null;
 const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',value:'',href:'rook-dashboard.html',files:[],classList:{toggle(){}},addEventListener(event,fn){this[event]=fn;},removeAttribute(){}});return elements.get(id);};
 const location={href:'rook-resume.html?rook_v8=1',search:'?rook_v8=1'};
 vm.runInNewContext(code,{URL,URLSearchParams,Date,FormData:class{append(key,value){this[key]=value;}},setTimeout:(fn,ms)=>timeouts.push({fn,ms}),document:{getElementById:get},location,window:{addEventListener(){},location},rookRequireAuth:async()=>true,rookApiFetch:async(url,options)=>{if(url==='/resume'){resume={filename:options.body.resume.name,url:'https://storage.example/owned-resume',uploaded_at:'2026-09-19T12:00:00Z'};return{ok:true,json:async()=>({ok:true,analysis_status:'ok'})};}return{ok:true,json:async()=>resume};}});
 await new Promise(r=>setImmediate(r));
 get('resumeFile').files=[{name:'V8.docx',size:100}];
 await get('uploadForm').submit({preventDefault(){}});
 assert.equal(get('viewUpdatedMatches').href,'rook-dashboard-v8.html');
 assert.equal(timeouts.length,1);
 timeouts[0].fn();
 assert.equal(location.href,'rook-dashboard-v8.html');
});
test('failed upload keeps current document and partial analysis reports upload separately',async()=>{
 const s=setup({filename:'Current.pdf',url:'https://storage.example/owned-resume'});await s.ready();s.fail();s.get('resumeFile').files=[{name:'Replacement.pdf',size:100}];await s.submit();assert.equal(s.get('filename').textContent,'Current.pdf');assert.match(s.get('status').textContent,/did not complete/);
 const partial=setup(null);await partial.ready();partial.partial();partial.get('resumeFile').files=[{name:'New.pdf',size:100}];await partial.submit();assert.match(partial.get('status').textContent,/contents could not be analyzed/);assert.equal(partial.get('filename').textContent,'New.pdf');
});
