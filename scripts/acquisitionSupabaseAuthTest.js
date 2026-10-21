'use strict';
// Real Supabase Auth + existing HTTP routes; isolated staging only, no emails sent.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const express=require('express');
const {createClient}=require('@supabase/supabase-js');
const {SupabaseAcquisitionStore}=require('../backend/organicAcquisition/store');
const {createRouter}=require('../backend/organicAcquisition/routes');
const {signer}=require('../backend/organicAcquisition/security');
async function run(){
 if(!process.argv.includes('--confirm-isolated-staging'))throw Error('Staging confirmation required');
 const file=process.env.ACQ_STAGING_CREDENTIAL_FILE;
 if(!file||(fs.statSync(file).mode&0o077))throw Error('Private staging credential file required');
 const c=JSON.parse(fs.readFileSync(file,'utf8'));
 const expected=process.env.ACQ_STAGING_PROJECT_REF,url=new URL(c.url);
 if(!expected||expected==='nazycunakcwfmusmiybd'||url.origin!=='https://'+expected+'.supabase.co')throw Error('Production refused');
 const opts={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
 const admin=createClient(url.origin,c.secret,opts),store=new SupabaseAcquisitionStore(admin);
 assert.equal((await store.call('get',{kind:'config',id:'provider-persistence-probe'}))?.probe,'ROOK-STAGING-20261021');
 const tag=crypto.randomUUID(),identities=[],checks=[];let server;
 try{
  for(const role of ['partner','buyer']){
   const email='rook-qa-'+role+'-'+tag+'@example.test',password=crypto.randomBytes(32).toString('base64url');
   const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{stagingValidation:true}});
   assert.ifError(created.error);identities.push({id:created.data.user.id,email});
   const signedIn=await createClient(url.origin,c.publicKey,opts).auth.signInWithPassword({email,password});
   assert.ifError(signedIn.error);identities[identities.length-1].token=signedIn.data.session.access_token;
  }
  checks.push('Two disposable staging users authenticate through real Supabase Auth; no verification emails requested');
  const [partner,buyer]=identities,signed=signer(crypto.randomBytes(32).toString('hex'));
  const app=express();app.use(express.json());
  app.use(createRouter({store,signer:signed,secureCookies:false,adminEmails:[partner.email],authenticate:async req=>{
   const token=(req.get('authorization')||'').replace(/^Bearer /,'');if(!token)return null;
   const r=await admin.auth.getUser(token);return r.error?null:r.data.user;
  }}));
  app.get('/api/staging-passive-probe',(req,res)=>res.json({ok:true}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const request=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
  const enroll=body=>request('/api/acquisition/partners',{method:'POST',headers:{authorization:'Bearer '+partner.token,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await enroll({terms:false})).status,400);
  const response=await enroll({terms:true,marketingConsent:false});assert.equal(response.status,200);
  const enrolled=await response.json(),code=new URL(enrolled.referralLink).pathname.split('/').pop();
  assert.equal((await enroll({terms:true,marketingConsent:false})).status,200);
  assert.equal((await store.call('list',{kind:'partner'})).filter(p=>p.body.userId===partner.id).length,1);
  assert.equal((await store.call('get',{kind:'partner',id:code})).marketingConsent,false);
  checks.push('Verified-user onboarding enforces terms, preserves opt-out and deduplicates real account enrollment');
  const referral=await request('/r/'+code);assert.equal(referral.status,302);
  const cookie=referral.headers.get('set-cookie').split(';')[0];
  await request('/api/staging-passive-probe',{headers:{authorization:'Bearer '+buyer.token,cookie}});
  const binding=await store.call('get',{kind:'binding',id:buyer.id});assert.equal(binding.partnerId,code);
  checks.push('Signed referral cookie binds the actual Supabase-authenticated buyer through the existing passive HTTP route');
  assert.equal((await request('/api/acquisition/admin')).status,401);
  assert.equal((await request('/api/acquisition/admin',{headers:{authorization:'Bearer '+buyer.token}})).status,403);
  assert.equal((await request('/api/acquisition/admin',{headers:{authorization:'Bearer '+partner.token}})).status,200);
  const own=await request('/api/acquisition/partner',{headers:{authorization:'Bearer '+partner.token}});assert.equal(own.status,200);
  assert.equal((await own.json()).referralLink,enrolled.referralLink);
  checks.push('Real authenticated partner reporting works; anonymous/non-admin users cannot read private admin metrics');
 }finally{
  if(server)await new Promise(r=>server.close(r));
  for(const u of identities){const deleted=await admin.auth.admin.deleteUser(u.id);assert.ifError(deleted.error);}
 }
 checks.push('Disposable Supabase Auth test accounts removed; no production users or subscriptions touched');
 const report={environment:'real isolated Supabase preview branch + local HTTP server',realSupabaseAuth:true,completedAt:new Date().toISOString(),checks,productionTouched:false,emailSent:false,stripeTransactionPerformed:false,secretValuesRecorded:false};
 fs.writeFileSync('docs/organic-growth/SUPABASE_AUTH_RESULT.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
run().catch(()=>{console.error('Hosted auth validation failed; provider response bodies and credentials suppressed.');process.exitCode=1;});
