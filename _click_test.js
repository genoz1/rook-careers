// Standalone click-through test — run this before every push to v4
// Catches ReferenceErrors and runtime crashes inside button handlers
const puppeteer = require('/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer');
const CHROME = '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';

(async () => {
  const errors = [];
  const b = await puppeteer.launch({args:['--no-sandbox','--disable-web-security'],executablePath:CHROME});
  const p = await b.newPage();
  await p.setViewport({width:390,height:844});
  await p.setRequestInterception(true);
  p.on('request', r => r.url().startsWith('file://') ? r.continue().catch(()=>{}) : r.respond({status:200,body:''}).catch(()=>{}));
  p.on('pageerror', e => {
    if (!e.message.includes('Supabase') && !e.message.includes('unavailable') && !e.message.includes('ROOK_CONFIG'))
      errors.push('PAGE ERR: ' + e.message.slice(0, 120));
  });

  await p.goto('file:///home/claude/rook-careers/public/rook-onboarding-v4.html', {waitUntil:'domcontentloaded', timeout:15000});
  await new Promise(r=>setTimeout(r,1500));

  let pass = 0, fail = 0;
  async function check(label, fn) {
    const err = await p.evaluate(fn).catch(e => 'EXCEPTION: ' + e.message);
    const ok = err !== false && !String(err).startsWith('EXCEPTION');
    console.log((ok?'  ✓':'  ✗') + ' ' + label + (ok ? '' : ' → ' + err));
    ok ? pass++ : fail++;
  }

  console.log('\n── Welcome → Details ──');
  await check('Welcome button click', () => { document.getElementById('btnWelcomeStart').click(); return true; });
  await new Promise(r=>setTimeout(r,200));

  console.log('── Details → Industry ──');
  await check('Location selected, Continue enabled', () => {
    window.selectedLocation = {city:'Tampa',state:'Florida',stateAbbr:'FL',zip:'33601',lat:27.9,lng:-82.5,label:'Tampa, FL'};
    document.getElementById('btnDetailsNext').disabled = false;
    document.getElementById('btnDetailsNext').click();
    return true;
  });
  await new Promise(r=>setTimeout(r,200));

  console.log('── Industry → Years ──');
  await check('Industry selected, Continue clicked', () => {
    document.querySelector('[name="industry"]').checked = true;
    document.getElementById('btnIndustryNext').disabled = false;
    document.getElementById('btnIndustryNext').click();
    return true;
  });
  await new Promise(r=>setTimeout(r,200));

  console.log('── Years → Territory ──');
  await check('Years selected, Continue clicked', () => {
    document.querySelector('[name="years"]').checked = true;
    document.getElementById('btnYearsNext').disabled = false;
    document.getElementById('btnYearsNext').click();
    return true;
  });
  await new Promise(r=>setTimeout(r,200));

  console.log('── Territory → Email ──');
  await check('Territory selected, Continue clicked', () => {
    document.querySelector('[name="territory"]').checked = true;
    document.getElementById('btnTerritoryNext').disabled = false;
    document.getElementById('btnTerritoryNext').click();
    return true;
  });
  await new Promise(r=>setTimeout(r,200));

  console.log('── Email submit (critical — resumeFile bug was here) ──');
  await check('Email entered, Find My Matches clicked — no crash', () => {
    document.getElementById('emailInput').value = 'test@example.com';
    document.getElementById('btnResumeNext').click();
    return true;
  });
  await new Promise(r=>setTimeout(r,600));

  await p.close(); await b.close();

  console.log(`\n${'─'.repeat(40)}`);
  if (errors.length) { console.log('Page errors:'); errors.forEach(e => console.log(' ', e)); }
  console.log(`${pass} passed, ${fail} failed, ${errors.length} page errors`);
  const allOk = fail === 0 && errors.length === 0;
  console.log(allOk ? '\n✓ SAFE TO PUSH' : '\n✗ DO NOT PUSH');
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
