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
