const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
let chromium;
try { ({chromium}=require(process.env.ROOK_PLAYWRIGHT_MODULE || 'playwright')); } catch (_) {}

const publicDir = path.resolve(__dirname, '../public');
const mime = {'.css':'text/css','.html':'text/html','.js':'application/javascript','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon'};

let server;
let origin;
let browser;

test.before(async () => {
  if (!chromium) return;
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://local.test').pathname;
    const file = path.join(publicDir, pathname === '/' ? 'rook-onboarding-v8.html' : pathname);
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404).end(); return;
    }
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.ROOK_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({headless:true, ...(fs.existsSync(executablePath) ? {executablePath} : {})});
});

test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function contextFor(viewport) {
  const context = await browser.newContext({viewport});
  await context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({
    contentType:'application/javascript',
    body:`window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'test-token'}}}),signOut:async()=>{}}})}`,
  }));
  await context.route('https://js.stripe.com/**', route => route.fulfill({
    contentType:'application/javascript',
    body:`window.Stripe=()=>({elements:()=>({create:()=>({mount(){},on(){}})}),confirmCardSetup:async()=>({})})`,
  }));
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType:'text/css',body:''}));
  await context.route('https://www.googletagmanager.com/**', route => route.fulfill({contentType:'application/javascript',body:''}));
  await context.route(`${origin}/api/profile`, route => route.fulfill({
    contentType:'application/json',
    body:JSON.stringify({trial_source:'v8',trial_started_at:'2026-01-01T00:00:00.000Z',trial_ends_at:'2026-01-01T01:00:00.000Z',subscription_status:'none',subscription_started_at:null}),
  }));
  await context.route(`${origin}/api/v8/prepare`, route => route.fulfill({contentType:'application/json',body:JSON.stringify({preparation:'test'})}));
  return context;
}

for (const viewport of [{width:1440,height:900},{width:1366,height:768},{width:1280,height:800}]) {
  test(`V8 initial modal and checkout essentials fit ${viewport.width}x${viewport.height}`, {skip:!chromium}, async () => {
    const context = await contextFor(viewport);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(`${origin}/rook-onboarding-v8.html`, {waitUntil:'domcontentloaded'});
    const modal = await page.locator('#searchForm').boundingBox();
    assert(modal, 'initial V8 modal is visible');
    assert(modal.y >= 10, `modal top ${modal.y} retains breathing room`);
    assert(modal.y + modal.height <= viewport.height - 10, `modal bottom ${modal.y + modal.height} fits viewport`);
    assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true);

    await page.goto(`${origin}/rook-checkout-v8.html`, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('submitBtn').disabled);
    const essentialBottom = await page.locator('.fine').evaluate(element => element.getBoundingClientRect().bottom);
    const button = await page.locator('#submitBtn').boundingBox();
    assert(button && button.y + button.height <= viewport.height, 'checkout CTA is visible without scrolling');
    assert(essentialBottom <= viewport.height - 8, `renewal disclosure bottom ${essentialBottom} fits viewport`);
    assert.equal(await page.locator('#formErr').textContent(), '');
    assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true);
    assert(!errors.some(message => message.includes('rookApiFetch')), errors.join('\n'));
    await context.close();
  });
}

test('V8 compact desktop rules do not create mobile overflow', {skip:!chromium}, async () => {
  const viewport={width:390,height:844};
  const context = await contextFor(viewport);
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  for (const pageName of ['rook-onboarding-v8.html','rook-checkout-v8.html']) {
    await page.goto(`${origin}/${pageName}`, {waitUntil:'domcontentloaded'});
    assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, `${pageName} has no horizontal overflow`);
  }
  assert(!errors.some(message => message.includes('rookApiFetch')), errors.join('\n'));
  await context.close();
});

test('checkout loads authenticated API helper before checkout orchestration', () => {
  const html=fs.readFileSync(path.join(publicDir,'rook-checkout-v8.html'),'utf8');
  const auth=html.indexOf('<script src="rook-auth-v8.js"></script>');
  const bridge=html.indexOf('<script src="rook-v8-checkout-bridge.js"></script>');
  const profile=html.indexOf("rookApiFetch('/profile')");
  assert(auth > -1 && bridge > auth && profile > bridge);
});
