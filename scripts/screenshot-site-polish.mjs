/**
 * Capture polish progress screenshots for Gene.
 * Usage: node scripts/screenshot-site-polish.mjs
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.ROOK_BASE || 'http://127.0.0.1:43123';
const OUT = process.env.ROOK_SHOT_DIR || '/opt/cursor/artifacts/screenshots';

const pages = [
  { name: 'homepage-hero', url: `${BASE}/index.html`, wait: 1200 },
  { name: 'login-v8', url: `${BASE}/rook-login-v8.html`, wait: 900 },
  { name: 'onboarding-v8', url: `${BASE}/rook-onboarding-v8.html`, wait: 1200 },
  { name: 'acquisition', url: `${BASE}/rook-acquisition.html`, wait: 1500 },
  { name: 'dashboard-loader', url: `${BASE}/rook-dashboard-v8.html`, wait: 800 },
  { name: 'search-loader', url: `${BASE}/rook-search.html`, wait: 800 },
  { name: 'loader-demo', url: `${BASE}/rook-loader-demo.html`, wait: 600 },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  for (const pageDef of pages) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    try {
      await page.goto(pageDef.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(pageDef.wait);
      const file = path.join(OUT, `polish-${pageDef.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log('saved', file);
    } catch (err) {
      console.error('failed', pageDef.name, err.message);
    } finally {
      await context.close();
    }
  }

  // Mobile homepage
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mpage = await mobile.newPage();
  await mpage.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await mpage.waitForTimeout(1000);
  const mobileFile = path.join(OUT, 'polish-homepage-mobile.png');
  await mpage.screenshot({ path: mobileFile, fullPage: false });
  console.log('saved', mobileFile);
  await mobile.close();
} finally {
  await browser.close();
}
