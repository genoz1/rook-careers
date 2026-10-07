const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

test('all old onboarding entries reach V8 in one redirect and retain attribution', async () => {
  let app;
  function fakeExpress() { app = express(); app.listen = () => null; return app; }
  Object.assign(fakeExpress, express);
  const root = path.join(__dirname, '..');
  const seo = { headers: (req, res, next) => next(), pages: (req, res, next) => next(), staticHeaders() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
    require(name) {
      if (name === 'express') return fakeExpress;
      if (name === 'dotenv') return { config() {} };
      if (name === 'path') return path;
      if (name === 'fs') return fs;
      if (name === './backend/publicSeo') return seo;
      if (name === './backend/socialShortLinks') return { createRouter: () => express.Router() };
      if (name === './backend/resources/routes') return { createRouter: () => express.Router() };
      if (name === './backend/industryNews/config') return { getFlags: () => ({industryNews:false}) };
      return express.Router();
    },
    __dirname: root, process: { env: {}, on() {} }, console, URLSearchParams,
  });
  const server = express.application.listen.call(app, 0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async url => fetch(origin + url, { redirect: 'manual' });
  try {
    for (const name of ['rook-onboarding.html', ...[2, 3, 4, 5, 6, 7].map(v => `rook-onboarding-v${v}.html`)]) {
      const response = await get(`/${name}?utm_source=google&gclid=a%2Bb`);
      assert.equal(response.status, 302, name);
      assert.equal(response.headers.get('location'), '/rook-onboarding-v8.html?utm_source=google&gclid=a%2Bb', name);
    }
    for (const name of ['rook-checkout.html', 'rook-checkout-v7.html', 'rook-onboarding-v6-signup.html', 'rook-onboarding-v7-signup.html']) {
      const response = await get(`/${name}?utm_source=email&utm_campaign=reactivation`);
      assert.equal(response.status, 302, name);
      assert.equal(response.headers.get('location'), '/rook-onboarding-v8.html?utm_source=email&utm_campaign=reactivation', name);
      assert.equal(response.headers.get('cache-control'), 'no-store', name);
    }
    for (const [from, to] of [
      ['/rook-onboarding-v2.html?ob=resume_upload', '/rook-resume.html?ob=resume_upload&rook_v8=1'],
      ['/rook-onboarding-v2.html?edit=preferences', '/rook-settings.html?edit=preferences&rook_v8=1'],
    ]) assert.equal((await get(from)).headers.get('location'), to);
    assert.equal((await get('/medical-sales/free-trial?utm_source=google')).headers.get('location'), '/rook-onboarding-v8.html?utm_source=google');
    assert.equal((await get('/medical-sales/rook-onboarding-v7.html?utm_source=meta')).headers.get('location'), '/rook-onboarding-v8.html?utm_source=meta');
    assert.equal((await get('/rook-keep-access.html?utm_source=email')).headers.get('location'), '/rook-checkout-v8.html?utm_source=email');
    const retiredApi=await get('/api/v9/session');
    assert.equal(retiredApi.status,410);
    assert.match(await retiredApi.text(),/offer is retired/i);
  } finally { server.close(); server.closeAllConnections(); }
});
