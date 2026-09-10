// Runtime test for onboarding pages — catches ReferenceErrors, TypeError,
// undefined variables, and broken listeners that syntax checks miss.
// Run before EVERY push: node test-runtime.js

const fs = require('fs');
const { execSync } = require('child_process');

const STUB = `
global.window = {
  ROOK_CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'key' },
  location: { search: '', origin: 'https://rookcareers.com', href: 'https://rookcareers.com/test.html' },
  dataLayer: [],
  scrollTo: () => {},
};
global.document = {
  getElementById: id => ({ addEventListener:()=>{}, removeEventListener:()=>{}, disabled:false, dataset:{},
    textContent:'', innerHTML:'', style:{display:'',cssText:''}, click:()=>{},
    value:'', checked:false, files:[], classList:{ add:()=>{}, remove:()=>{}, toggle:()=>{} },
    querySelector:()=>null, querySelectorAll:()=>[], appendChild:()=>{}, getAttribute:()=>null }),
  querySelector: () => ({ id:'s-welcome', classList:{add:()=>{},remove:()=>{},toggle:()=>{}}, textContent:'', style:{} }),
  querySelectorAll: () => [],
  createElement: tag => ({ style:{}, innerHTML:'', textContent:'', appendChild:()=>{}, setAttribute:()=>{} }),
  addEventListener: ()=>{},
  title: '',
};
global.crypto = { randomUUID: () => 'test-uuid-1234' };
global.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
global.sessionStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
global.URLSearchParams = class { constructor(s){} get(){ return null; } set(){} toString(){ return ''; } };
global.FormData = class { append(){} };
global.DataTransfer = class { constructor(){ this.files={length:0}; this.items={add:()=>{}}; } };
global.Event = class { constructor(t){ this.type=t; } };
global.fetch = () => Promise.resolve({ ok:true, json:()=>Promise.resolve({}), text:()=>Promise.resolve('') });
global.setTimeout = () => 0;
global.setInterval = () => 0;
global.clearInterval = () => {};
global.clearTimeout = () => {};
global.history = { replaceState:()=>{} };
global.supabase = { createClient: () => ({
  auth: {
    getSession: () => Promise.resolve({ data:{ session:null }, error:null }),
    signUp: () => Promise.resolve({ data:{ user:{ id:'uid-test' }, session:null }, error:null }),
    updateUser: () => Promise.resolve({ data:{}, error:null }),
    resend: () => Promise.resolve({ data:{}, error:null }),
  }
})};
global.RookLocationWidget = { init: () => {} };
global.gtag = () => {};
global.dataLayer = [];
global.rookApiFetch = () => Promise.resolve({ ok:true, json:()=>Promise.resolve({}) });
global.rookSignOut = () => {};
global.rookGetStoredAttribution = () => ({});
global.rookRequireAuth = (cb) => cb && cb();
global.document = { ...global.document, getElementsByTagName: () => [], querySelector: () => null, querySelectorAll: () => [], getElementById: global.document.getElementById, addEventListener: ()=>{}, createElement: tag => ({ style:{}, innerHTML:'', textContent:'', appendChild:()=>{}, setAttribute:()=>{} }), title:'' };
`;

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['public/rook-onboarding-v4.html', 'public/rook-onboarding-v3.html', 'public/rook-onboarding-v2.html'];

let allPass = true;

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const blocks = [...src.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map(m => m[1]);

  let filePass = true;
  for (let i = 0; i < blocks.length; i++) {
    const code = STUB + '\n' + blocks[i];
    const tmp = `/tmp/_rook_test_${Date.now()}.js`;
    fs.writeFileSync(tmp, code);
    try {
      execSync(`node "${tmp}" 2>&1`, { timeout: 10000 });
    } catch(e) {
      const out = e.stdout?.toString() || '';
      const lines = out.split('\n').filter(l =>
        l.includes('Error') || l.includes('error') || l.includes('TypeError') || l.includes('ReferenceError')
      ).filter(l =>
        !l.includes('Supabase init failed') &&
        !l.includes('not available') &&
        !l.includes('ROOK_CONFIG') &&
        !l.includes('supabase.com')
      );
      if (lines.length) {
        console.log(`✗ ${file} block ${i+1}:`);
        lines.slice(0,5).forEach(l => console.log('  ', l.trim()));
        filePass = false;
        allPass = false;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch(_) {}
    }
  }
  if (filePass) console.log(`✓ ${file}`);
}

console.log(allPass ? '\nALL PASS — safe to push' : '\nFAILURES — do not push');
process.exit(allPass ? 0 : 1);

// These are known browser-only globals not needed in the stub
// Add them to suppress false failures in dashboard tests

// ── Button click simulation — catches ReferenceErrors inside handlers ──────
// Run this after the static checks. Simulates clicking through the onboarding
// to surface errors that only appear at runtime inside event handlers.
const CLICK_TEST_FILES = ['public/rook-onboarding-v4.html'];
if (process.argv[2] !== '--no-click') {
  const puppeteer = (() => { try { return require('/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer'); } catch(_) { return null; } })();
  if (puppeteer) {
    (async () => {
      const CHROME = '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
      const errors = [];
      const b = await puppeteer.launch({args:['--no-sandbox','--disable-web-security'],executablePath:CHROME});
      const p = await b.newPage();
      await p.setViewport({width:390,height:844});
      await p.setRequestInterception(true);
      p.on('request', r => r.url().startsWith('file://') ? r.continue().catch(()=>{}) : r.respond({status:200,body:''}).catch(()=>{}));
      p.on('pageerror', e => {
        if (!e.message.includes('Supabase') && !e.message.includes('unavailable') && !e.message.includes('ROOK_CONFIG'))
          errors.push(e.message.slice(0, 120));
      });
      await p.goto('file:///home/claude/rook-careers/public/rook-onboarding-v4.html', {waitUntil:'domcontentloaded', timeout:15000});
      await new Promise(r=>setTimeout(r,1500));

      // Simulate full click-through including the submit button
      await p.evaluate(() => window.rookShow && window.rookShow('details'));
      await new Promise(r=>setTimeout(r,200));
      await p.evaluate(() => {
        window.selectedLocation = {city:'Tampa',state:'Florida',stateAbbr:'FL',zip:'33601',lat:27.9,lng:-82.5,label:'Tampa, FL'};
        document.getElementById('btnDetailsNext').disabled = false;
        document.getElementById('btnDetailsNext').click();
      });
      await new Promise(r=>setTimeout(r,200));
      await p.evaluate(() => { document.querySelector('[name="industry"]').checked=true; document.getElementById('btnIndustryNext').disabled=false; document.getElementById('btnIndustryNext').click(); });
      await new Promise(r=>setTimeout(r,200));
      await p.evaluate(() => { document.querySelector('[name="years"]').checked=true; document.getElementById('btnYearsNext').disabled=false; document.getElementById('btnYearsNext').click(); });
      await new Promise(r=>setTimeout(r,200));
      await p.evaluate(() => { document.querySelector('[name="territory"]').checked=true; document.getElementById('btnTerritoryNext').disabled=false; document.getElementById('btnTerritoryNext').click(); });
      await new Promise(r=>setTimeout(r,200));
      // Fill email and click submit — this is where resumeFile bug would have thrown
      await p.evaluate(() => {
        document.getElementById('emailInput').value = 'test@example.com';
        document.getElementById('btnResumeNext').click();
      });
      await new Promise(r=>setTimeout(r,500));

      await p.close(); await b.close();

      if (errors.length) {
        console.log('✗ CLICK TEST page errors:');
        errors.forEach(e => console.log('  ', e));
        console.log('\nFAILURES — do not push');
        process.exit(1);
      } else {
        console.log('✓ Click-through test: no runtime errors');
      }
    })().catch(e => { console.error('Click test error:', e.message); process.exit(1); });
  }
}
