// Navigation regression only; no accounts, payments or external services.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const job='9980b1fc-c214-4c65-9f3f-70d46e748be6';
(async()=>{
 for(const unlocked of [false,true]) for(const selected of [job,'https://evil.invalid','not-a-job']) {
  const storage=new Map([['rook_v7_return_job',selected]]);let destination=null;
  const context={URLSearchParams,encodeURIComponent,location:{search:''},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{location:{replace:u=>destination=u}},document:{getElementById:()=>null}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('public/rook-v7.js','utf8'),context);
  vm.runInContext(`rookV7Read=async()=>{rookV7Unlocked=${unlocked};rookV7Snapshot={profile:{subscription_status:'trialing'}}}`,context);
  await vm.runInContext('rookV7Init()',context);
  assert.equal(destination,unlocked&&selected===job?'/rook-job-analysis.html?job='+job:null);
 }
 const html=fs.readFileSync('public/rook-dashboard.html','utf8');
 const block=html.slice(html.indexOf('        // Return social visitors'),html.indexOf('        if (profile?.name)'));
 for(const full of [false,true]) {
  let destination=null;const storage=new Map([['rook_v7_return_job',job]]);
  vm.runInNewContext('(function(){'+block+'})()',{profile:{},rookHasFullAccess:()=>full,encodeURIComponent,sessionStorage:{getItem:k=>storage.get(k),removeItem:k=>storage.delete(k)},window:{location:{replace:u=>destination=u}}});
  assert.equal(destination,full?'/rook-job-analysis.html?job='+job:null);
 }
 console.log('PASS exact-job return on V7 and current checkout dashboard; locked access and arbitrary destinations rejected.');
})().catch(e=>{console.error(e);process.exitCode=1});
