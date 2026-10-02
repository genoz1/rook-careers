'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { buildCandidateReport } = require('./report');
const views = require('./views');

function equalSecret(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createAdminRouter({ store }) {
  const router = express.Router();
  router.get('/internal/industry-news/candidates', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!equalSecret(req.get('x-rook-admin-key'), process.env.INDUSTRY_NEWS_ADMIN_KEY)) return res.status(404).send('Not found');
    try {
      const report = buildCandidateReport(await store.candidateReport(req.query.run || null));
      if (req.accepts(['html', 'json']) === 'json') return res.json(report);
      return res.type('html').send(views.adminReport(report));
    } catch {
      return res.status(503).send('Candidate report unavailable');
    }
  });
  return router;
}

module.exports = { equalSecret, createAdminRouter };
