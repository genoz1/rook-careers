'use strict';
// Local-only demonstration. ALL users, revenue and provider receipts are fixtures.
// Never loads dotenv, production services or provider credentials.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const express=require('express');
const {PGlite}=require('@electric-sql/pglite');
const {PostgresAcquisitionStore}=require('../backend/organicAcquisition/store');
const {signer}=require('../backend/organicAcquisition/security');
const {createRouter}=require('../backend/organicAcquisition/routes');
const worker=require('../backend/organicAcquisition/worker');
async function run(){
 const serving=process.argv.includes('--serve');
 if(serving&&process.env.ROOK_ACQ_LOCAL_PREVIEW!=='true')throw Error('Local preview authorization flag required');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rook-acquisition-staging-'));
 let db=new PGlite(directory);await db.exec(fs.readFileSync(require.resolve('../backend/organicAcquisition/schema.sql'),'utf8'));const store=new PostgresAcquisitionStore(db),signed=signer('LOCAL_STAGING_FIXTURE_SIGNING_KEY_NO_REAL_CREDENTIAL'),now=Date.now();
 const stamp=new Date(now).toISOString(),partnerId='abcdefghijklmnopqrstuvwx';
 await store.call('put',{kind:'config',id:'launch',body:{baselineComplete:true,goLiveAt:new Date(now-86400000).toISOString()}});
 for(let i=1;i<=3;i++)await store.call('put',{kind:'baseline',id:'existing-fixture-'+i,body:{customerId:'cus_fixture_'+i,identityHash:signed.identity('fixture'+i+'@example.test')}});
 await store.call('enroll',{id:partnerId,userId:'partner',email:'partner@example.test',identityHash:signed.identity('partner@example.test'),emailVerified:true,marketingConsent:false,status:'active',createdAt:stamp});
 const snapshot=JSON.parse(fs.readFileSync(require.resolve('../docs/organic-growth/baseline-inventory.json'),'utf8'));snapshot.capturedAt=stamp;snapshot.collections=snapshot.collections.map(c=>({...c,jobs:120,representedEmployers:12}));
 await store.call('put',{kind:'snapshot',id:'latest',body:snapshot});await worker.publishReports(store,snapshot,now);
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{res.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'");next();});
 app.get('/staging-visual-qa',(req,res)=>res.type('html').send('<!doctype html><html><head><title>ROOK local visual QA</title><style>body{font:16px system-ui;margin:20px}iframe{border:1px solid #aaa;height:1200px;display:block;margin-bottom:30px}</style></head><body><h1>ROOK local visual QA — synthetic data only</h1><p>No production services or analytics are connected.</p>'+['/partners/','/partners/dashboard/','/hiring-reports/medical-sales-'+new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit'}).format(new Date(now))+'/','/internal/acquisition'].map(route=>'<h2>'+route+'</h2>'+[390,1280].map(width=>'<h3>'+width+'px</h3><iframe title="'+route+' '+width+'px" src="'+route+'" width="'+width+'"></iframe>').join('')).join('')+'</body></html>'));
 if(serving)app.get('/',(req,res)=>res.redirect('/staging-visual-qa'));

 app.use((req,res,next)=>{const send=res.send.bind(res);res.send=body=>send(typeof body==='string'&&body.includes('<body>')?body.replace('<body>','<body><p role="note" style="background:#ffedb5;padding:12px"><strong>LOCAL STAGING — synthetic users, counts, payments and provider receipts. Nothing is live.</strong></p>'):body);next();});
 app.get('/rook-config.js',(req,res)=>res.type('js').send('window.ROOK_CONFIG={};'));
 app.get('/rook-auth.js',(req,res)=>res.type('js').send('async function rookGetAccessToken(){return location.pathname.includes("internal")?"staging-admin":"staging-partner";}'));
 app.use(createRouter({store,signer:signed,secureCookies:false,adminEmails:['admin@example.test'],authenticate:async req=>{const t=req.get('authorization');const id=t==='Bearer staging-admin'?'admin':t==='Bearer staging-partner'?'partner':t==='Bearer staging-buyer'?'buyer':null;return id?{id,email:id+'@example.test',email_confirmed_at:stamp}:null;}}));
 app.get('/api/staging-account-probe',(req,res)=>res.json({ok:true}));app.use(express.static(path.join(__dirname,'../public')));
 const server=app.listen(serving?4173:0,serving?'0.0.0.0':'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const results={environment:'local staging',realProviderDelivery:false,realStripeTestMode:false,publicDeployment:false,steps:[],uiChecks:[]};
 let browser;
 try{
  const ref=await fetch(base+'/r/'+partnerId,{redirect:'manual'});const cookie=ref.headers.get('set-cookie').split(';')[0];
  await fetch(base+'/api/staging-account-probe',{headers:{Authorization:'Bearer staging-buyer',Cookie:cookie}});
  const commission=await store.call('paid',{eventId:'evt_staging_fixture',eligible:true,userId:'buyer',customerId:'cus_staging_buyer',identityHash:signed.identity('buyer@example.test'),fingerprintHash:signed.identity('staging-card'),invoiceId:'in_staging_fixture',subscriptionId:'sub_staging_fixture',invoiceCreatedAt:new Date(Date.now()+1000).toISOString(),paidAt:new Date(Date.now()+1000).toISOString(),amountCents:1999,channel:'referral_partner'});
  if(!commission.credited)throw Error('Staging referral did not accrue');results.steps.push('HTTP referral cookie -> verified fixture account binding -> one $5 ledger commission');
  const candidate=require('../backend/organicAcquisition/content').candidates(null,now)[0];
  for(const channel of ['li-staging','fb-staging'])await store.call('enqueue',{id:'staging-'+channel,lane:'social',channel,payload:{text:candidate.text,url:candidate.url,contentHash:candidate.hash},dueAt:stamp});
  const receipts=[];const adapter={async publish(row){receipts.push(row.id);return {status:'published',id:'fixture-receipt-'+row.id};}};
  while(await worker.dispatchOne(store,{adapter,now:Date.now(),check:async()=>true})){}
  if(receipts.length!==2)throw Error('Staging delivery count failed');results.steps.push('Persistent queue -> two fixture provider confirmations -> no duplicate dispatch');
  await store.call('put',{kind:'metrics',id:'stripe',body:{capturedAt:stamp,activePayingSubscribers:3,fullPricePlanSubscribers:3,normalizedMrrCents:5997,newPaidSubscriptionStartsLast28Days:0,cancellationsLast28Days:0,targetCents:100000,targetSubscribers:51,mrrDefinition:'SYNTHETIC staging baseline; not verified live revenue.'}});
  await store.call('put',{kind:'metrics',id:'health',body:await worker.health(store)});
  const reportRows=await store.call('list',{kind:'report'});if(reportRows.length!==4)throw Error('Report generation failed');results.steps.push('Four aggregate-only report pages rendered locally');
  if(process.argv.includes('--ui-check')){
   const {chromium}=require('playwright');browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();
   // No external CDN or analytics request is permitted in this local demo.
   await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
   for(const viewport of [{width:390,height:844},{width:1280,height:900}]){
    await page.setViewportSize(viewport);
    for(const route of ['/partners/','/partners/dashboard/','/hiring-reports/'+reportRows[0].id+'/','/internal/acquisition']){
     await page.goto(base+route);await page.waitForSelector('h1');
     if(route.includes('/internal/'))await page.getByText('Active paying subscribers',{exact:true}).waitFor();
     if(route.includes('/dashboard/'))await page.getByText('Your unique referral link',{exact:true}).waitFor();
     const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
     if(overflow)throw Error('Horizontal overflow at '+route+' '+viewport.width);
     results.uiChecks.push({route,viewport:viewport.width,passed:true});
    }
   }await browser.close();browser=null;
  }
  if(serving){console.log('ROOK LOCAL PREVIEW READY — synthetic data only; no external services connected');await new Promise(resolve=>process.once('SIGTERM',resolve));}
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));await db.close();}
 db=new PGlite(directory);const restored=new PostgresAcquisitionStore(db);const ledger=await restored.call('commissions'),outbox=await restored.call('outbox');if(ledger.length!==1||outbox.filter(r=>r.status==='published').length!==2)throw Error('Database restart persistence failed');results.steps.push('Close/reopen on-disk Postgres: referral ledger and confirmed publications preserved');await db.close();fs.rmSync(directory,{recursive:true,force:true});
 fs.writeFileSync(path.join(__dirname,'../docs/organic-growth/STAGING_DEMO_RESULT.json'),JSON.stringify({...results,completedAt:new Date().toISOString()},null,2)+'\n');console.log(JSON.stringify(results,null,2));
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
