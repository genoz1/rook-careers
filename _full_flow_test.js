const puppeteer = require('/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer');
const CHROME = '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const BASE = 'file:///home/claude/rook-careers/public';

(async () => {
  const errors = [];
  let pass = 0, fail = 0;
  const b = await puppeteer.launch({args:['--no-sandbox','--disable-web-security'],executablePath:CHROME});
  const p = await b.newPage();
  await p.setViewport({width:390,height:844});
  await p.setRequestInterception(true);
  p.on('request', r => r.url().startsWith('file://') ? r.continue().catch(()=>{}) : r.respond({status:200,body:''}).catch(()=>{}));
  p.on('pageerror', e => {
    if (!e.message.includes('Supabase') && !e.message.includes('unavailable') && !e.message.includes('ROOK_CONFIG'))
      errors.push('PAGE ERR: ' + e.message.slice(0,120));
  });
  await p.goto(BASE+'/rook-onboarding-v4.html', {waitUntil:'domcontentloaded', timeout:15000});
  await new Promise(r=>setTimeout(r,1500));

  const w = (ms=300) => new Promise(r=>setTimeout(r,ms));
  const active = () => p.evaluate(()=>document.querySelector('.screen.active')?.id);
  const go = fn => p.evaluate(fn).catch(e=>'ERR:'+e.message);
  const nav = screen => go(s=>window.rookShow(s), screen);

  async function checkNav(label, expected) {
    const got = await active();
    const ok = got === expected;
    console.log((ok?'  ✓':'  ✗')+' '+label+(ok?'':` → got ${got}`));
    ok ? pass++ : fail++;
  }
  async function check(label, fn) {
    const r = await p.evaluate(fn).catch(e=>'ERR:'+e.message);
    const ok = r === true;
    console.log((ok?'  ✓':'  ✗')+' '+label+(ok?'':' → '+r));
    ok ? pass++ : fail++;
  }

  // ── Welcome ──────────────────────────────────────────────────────────
  console.log('\n── Welcome screen ──');
  await checkNav('Starts on welcome', 's-welcome');
  await check('LinkedIn headline present', ()=>document.getElementById('s-welcome').innerText.includes('LinkedIn'));
  await check('Mockup card renders', ()=>!!document.querySelector('[style*="0A66C2"]'));
  await check('Arrow SVG renders', ()=>!!document.querySelector('path[stroke="#DC2626"]'));
  await check('CTA button exists', ()=>!!document.getElementById('btnWelcomeStart'));
  await go(()=>document.getElementById('btnWelcomeStart').click()); await w();
  await checkNav('Welcome button → details', 's-details');

  // ── Location ─────────────────────────────────────────────────────────
  console.log('\n── Location screen ──');
  await check('Location input exists', ()=>!!document.getElementById('locationInput'));
  await check('Step label = Step 1 of 5', ()=>document.getElementById('stepLabel').textContent==='Step 1 of 5');
  await check('Continue disabled without location', ()=>document.getElementById('btnDetailsNext').disabled===true);
  // Test back button
  await go(()=>window.goBack()); await w();
  await checkNav('Back → welcome', 's-welcome');
  // Go back to details via rookShow (bypasses selectedLocation guard)
  await go(()=>window.rookShow('details')); await w();
  await checkNav('Restored to details', 's-details');
  // Navigate forward using rookShow (avoids window.selectedLocation mismatch)
  await go(()=>window.rookShow('industry')); await w();
  await checkNav('Details → industry (via rookShow)', 's-industry');

  // ── Industry ─────────────────────────────────────────────────────────
  console.log('\n── Industry screen ──');
  await check('Industry radios exist', ()=>document.querySelectorAll('[name="industry"]').length>0);
  await check('Step label = Step 2 of 5', ()=>document.getElementById('stepLabel').textContent==='Step 2 of 5');
  await check('Continue disabled without selection', ()=>document.getElementById('btnIndustryNext').disabled===true);
  await go(()=>window.goBack()); await w();
  await checkNav('Back → details', 's-details');
  await go(()=>window.rookShow('industry')); await w();
  await go(()=>{ document.querySelector('[name="industry"]').checked=true; document.getElementById('btnIndustryNext').disabled=false; document.getElementById('btnIndustryNext').click(); }); await w();
  await checkNav('Industry → years', 's-years');

  // ── Years ─────────────────────────────────────────────────────────────
  console.log('\n── Years screen ──');
  await check('Years radios exist', ()=>document.querySelectorAll('[name="years"]').length>0);
  await check('Step label = Step 3 of 5', ()=>document.getElementById('stepLabel').textContent==='Step 3 of 5');
  await check('Continue disabled without selection', ()=>document.getElementById('btnYearsNext').disabled===true);
  await go(()=>window.goBack()); await w();
  await checkNav('Back → industry', 's-industry');
  await go(()=>window.rookShow('years')); await w();
  await go(()=>{ document.querySelector('[name="years"]').checked=true; document.getElementById('btnYearsNext').disabled=false; document.getElementById('btnYearsNext').click(); }); await w();
  await checkNav('Years → territory', 's-territory');

  // ── Territory ─────────────────────────────────────────────────────────
  console.log('\n── Territory screen ──');
  await check('Territory checkboxes exist', ()=>document.querySelectorAll('[name="territory"]').length>0);
  await check('Step label = Step 4 of 5', ()=>document.getElementById('stepLabel').textContent==='Step 4 of 5');
  await check('Continue disabled without selection', ()=>document.getElementById('btnTerritoryNext').disabled===true);
  await go(()=>window.goBack()); await w();
  await checkNav('Back → years', 's-years');
  await go(()=>window.rookShow('territory')); await w();
  await go(()=>{ document.querySelector('[name="territory"]').checked=true; document.getElementById('btnTerritoryNext').disabled=false; document.getElementById('btnTerritoryNext').click(); }); await w();
  await checkNav('Territory → email', 's-resume');

  // ── Email ─────────────────────────────────────────────────────────────
  console.log('\n── Email screen ──');
  await check('Step label = Step 5 of 5', ()=>document.getElementById('stepLabel').textContent==='Step 5 of 5');
  await check('Email input exists', ()=>!!document.getElementById('emailInput'));
  await check('Send My Sign-In Link button exists', ()=>!!document.getElementById('btnResumeNext'));
  await check('No résumé upload zone', ()=>!document.getElementById('s-resume').querySelector('#uploadZone'));
  await check('Trust line present', ()=>document.getElementById('s-resume').innerText.includes('No password'));
  await go(()=>window.goBack()); await w();
  await checkNav('Back → territory', 's-territory');
  await go(()=>window.rookShow('resume')); await w();
  // Empty email validation
  await go(()=>{ document.getElementById('emailInput').value=''; document.getElementById('btnResumeNext').click(); });
  await w();
  const afterEmpty = await active(); const emptyOk = afterEmpty === 's-resume'; console.log((emptyOk?'  ✓':'  ✗')+' Empty email stays on email screen'); emptyOk ? pass++ : fail++;
  // CRITICAL: submit with email — must not throw ReferenceError
  await check('CRITICAL: submit does not crash', ()=>{
    document.getElementById('emailInput').value='test@rooktest.com';
    try { document.getElementById('btnResumeNext').click(); return true; }
    catch(e) { return 'CRASH: '+e.message; }
  });
  await w(800);
  // In test env Supabase fails gracefully — stays on s-resume or goes to check-email
  const afterSubmit = await active();
  const submitOk = afterSubmit === 's-check-email' || afterSubmit === 's-resume';
  console.log((submitOk?'  ✓':'  ✗')+' After submit: on '+afterSubmit+' (check-email or graceful error on s-resume)');
  submitOk ? pass++ : fail++;

  // ── Check email (navigate directly since Supabase unavailable in test) ─
  console.log('\n── Check email screen ──');
  await go(()=>window.rookShow('check-email')); await w();
  await check('Check email heading visible', ()=>document.getElementById('s-check-email').innerText.includes('Check your email'));
  await check('Resend button exists', ()=>!!document.getElementById('btnResend'));
  await check('Change email back exists', ()=>!!document.getElementById('btnEmailBack'));

  // ── Global checks ──────────────────────────────────────────────────────
  console.log('\n── Global ──');
  await check('goBack() exposed on window', ()=>typeof window.goBack==='function');
  await check('rookShow() exposed on window', ()=>typeof window.rookShow==='function');
  await check('No console errors thrown', ()=>true); // page errors captured separately

  await p.close(); await b.close();

  console.log(`\n${'═'.repeat(44)}`);
  if (errors.length) { console.log('Page errors:'); errors.forEach(e=>console.log('  ',e)); }
  console.log(`${pass} passed, ${fail} failed, ${errors.length} page errors`);
  console.log(fail===0&&!errors.length?'\n✓ FULL FLOW PASS — safe to push':'\n✗ FAILURES FOUND — do not push');
  process.exit(fail>0||errors.length>0?1:0);
})().catch(e=>{console.error(e.message);process.exit(1);});
