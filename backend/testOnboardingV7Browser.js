const {chromium}=require(process.env.ROOK_PLAYWRIGHT_MODULE || 'playwright');
const express=require('express');
const assert=require('node:assert/strict');
const app=express();app.use(express.static(require('node:path').join(__dirname,'../public')));
(async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({...(process.env.ROOK_CHROME_PATH ? {executablePath:process.env.ROOK_CHROME_PATH} : {}),headless:true});
 try {
 for(const upload of [false,true]) {
  const context=await browser.newContext({viewport:{width:1280,height:900}});let unlocked=false,pending=false,claimed=false,processed=false;const events=[],errors=[];
  const profile={home_lat:42,home_lng:-71,home_location_label:'Boston, MA',desired_industries:['Medical Device']};
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   if(u.href.includes('supabase')) return route.fulfill({contentType:'application/javascript',body:`window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:sessionStorage.getItem('test_auth')?{access_token:'test',user:{email:'test@example.invalid'}}:null}}),signUp:async()=>({data:{user:{id:'test-user'}}}),verifyOtp:async()=>{sessionStorage.setItem('test_auth','1');return {data:{session:{access_token:'test'},user:{id:'test-user',email_confirmed_at:'today'}}}},resend:async()=>({}),signOut:async()=>({})}})};`});
   if(u.href.startsWith('https://js.stripe.com')) return route.fulfill({contentType:'application/javascript',body:`window.Stripe=()=>({elements:()=>({create:()=>({mount:()=>{},on:()=>{}})}),confirmCardSetup:async()=>({setupIntent:{payment_method:'test-card'}})});`});
   if(u.origin!==origin) return route.fulfill({body:''});
   if(u.pathname==='/rook-config.js') return route.fulfill({contentType:'application/javascript',body:`window.ROOK_CONFIG={SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'test',STRIPE_PUBLISHABLE_KEY:'pk_test',API_BASE:'/api'};`});
   if(u.pathname==='/api/location-search') return json([{label:'Boston, MA',city:'Boston',state:'MA',lat:42,lng:-71}]);
   if(u.pathname==='/api/v7/session' && route.request().method()==='POST') return json({token:'a'.repeat(64)});
   if(u.pathname==='/api/v7/claim') {claimed=true;return json({ok:true});}
   if(u.pathname==='/api/v7/resume') {
    if(route.request().method()==='POST') {pending=true;return json({ok:true});}
    return route.fulfill({headers:{'X-Resume-Name':'resume.pdf','X-Resume-Type':'application/pdf'},body:'test resume'});
   }
   if(u.pathname==='/api/resume') {processed=true;return json({ok:true});}
   if(u.pathname==='/api/v7/resume-complete') {pending=false;return json({ok:true});}
   if(u.pathname==='/api/v7/session') return json({unlocked,resume_pending:pending,profile:{...profile,...(claimed?{user_id:'test-user'}:{}),resume_file_path:processed?'test-user/resume.pdf':pending?'pending':null,subscription_status:unlocked?'trialing':null},jobs:[{id:unlocked?'real-job':'locked-0',title_original:'Regional Sales Manager',company_name:unlocked?'Test Employer':undefined,location_raw:'Boston, MA',distance_miles:4,subscription_required:!unlocked,match:{overall_score:84,preference_fit:84,reasons:[],concerns:[]}}]});
   if(u.pathname==='/api/stripe/create-setup-intent') return json({client_secret:'fake',customer_id:'fake'});
   if(u.pathname==='/api/stripe/create-subscription-from-setup') {unlocked=true;return json({ok:true});}
   if(u.pathname.startsWith('/api/')) return json([]);
   return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/rook-onboarding-v7.html');await page.click('#btnWelcomeStart');await page.fill('#locationInput','Boston');await page.click('.rlw-item');await page.click('#btnDetailsNext');await page.check('input[value="Medical Device"]');await page.click('#btnIndustryNext');await page.check('input[name="years"][value="5.5"]');await page.click('#btnYearsNext');await page.check('input[name="territory"][value="local"]');await page.click('#btnTerritoryNext');await page.waitForURL('**/rook-dashboard-v7.html');await page.waitForSelector('#jobList .job-row');await page.waitForSelector('#profileGateOverlay.active');
  if(upload){await page.setInputFiles('#profileGateResumeInput',{name:'resume.pdf',mimeType:'application/pdf',buffer:Buffer.from('test resume')});await page.waitForEvent('load');await page.waitForSelector('#jobList .job-row');assert.equal(await page.locator('#profileGateOverlay.active').count(),0);}else await page.click('#profileGateDismiss');
  assert.equal(await page.locator('#jobList .job-row').count(),1);assert(!(await page.locator('#jobList').innerText()).includes('Test Employer'));
  await page.click('#unlockBannerBtn');await page.waitForURL('**/rook-onboarding-v7-signup.html');await page.fill('#firstName','Test');await page.fill('#lastName','User');await page.fill('#emailInput','test@example.invalid');await page.fill('#passwordInput','Testing123!');await page.click('#btnCreateAccount');await page.fill('#codeInput','12345678');await page.click('#btnVerifyCode');await page.waitForURL('**/rook-checkout-v7.html');await page.waitForFunction(()=>!document.getElementById('submitBtn').disabled);await page.click('#submitBtn');await page.waitForURL('**/rook-dashboard-v7.html?trial=started');await page.waitForSelector('#jobList .job-row');
  assert((await page.locator('#jobList').innerText()).includes('Test Employer'));
  assert.equal(await page.locator('#profileGateOverlay.active').count(),upload?0:1);
  assert.equal(processed,upload);assert.deepEqual(errors,[]);
  await context.close();console.log(`PASS browser: four questions → dashboard → ${upload?'Upload':'Skip'} → current email-code signup → card checkout → same unmasked job; résumé popup correct.`);
 }
 } finally {await browser.close();server.close();server.closeAllConnections();}
})().catch(e=>{console.error(e);process.exitCode=1;});
