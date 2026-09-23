const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {boundedEmployer}=require('./ingestDeadline');
test('non-cooperative employer is killed and returns timeout',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rook-deadline-')),worker=path.join(dir,'worker.js');
 fs.writeFileSync(worker,"process.on('message',()=>{process.send({type:'progress',metrics:{inserted:2,updated:4}});setInterval(()=>{},1000);});");
 try{const started=Date.now();const r=await boundedEmployer({id:'fake'},500,{worker});assert.equal(r.status,'timeout');assert.equal(r.counts_complete,false);assert.equal(r.metrics.inserted,2);assert(Date.now()-started<3000);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('completed worker distinguishes inserts from updates and exits',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rook-deadline-')),worker=path.join(dir,'worker.js');
 fs.writeFileSync(worker,"process.on('message',()=>process.send({type:'done',result:{status:'partial'},metrics:{inserted:1,updated:8,partial_snapshots:1}},()=>process.exit(0)));");
 try{const r=await boundedEmployer({id:'fake'},3000,{worker});assert.equal(r.status,'partial');assert.equal(r.metrics.inserted,1);assert.equal(r.metrics.updated,8);assert.equal(r.counts_complete,true);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
