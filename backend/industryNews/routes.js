'use strict';
const express = require('express');
const { category } = require('./catalog');
const { origin } = require('../resources/catalog');
const views = require('./views');
function redirectNewsRoot(req, res, next) {
  // Express's default non-strict routing also matches /news/ here. Let the
  // canonical index handler render it instead of redirecting it to itself.
  if (req.path === '/news/') return next();
  return res.redirect(301, '/news/');
}
function createRouter(deps = {}) {
  const router = express.Router(); const store = deps.store;
  if (!store) throw new Error('Industry News public routes require a store');
  const guard = fn => async (req, res) => { try { await fn(req, res); } catch { res.status(503).set('Retry-After', '300').set('Cache-Control', 'no-store').send('Industry News is temporarily unavailable.'); } };
  router.get('/industry-news*', (req, res) => res.redirect(301, req.originalUrl.replace(/^\/industry-news/, '/news')));
  router.use('/news', (req, res, next) => { res.set('Cache-Control', 'public, max-age=60'); next(); });
  router.get('/news', redirectNewsRoot);
  router.get('/news/', guard(async (req, res) => res.type('html').send(views.index(await store.listArticles()))));
  router.get('/news/category/:category/', (req, res) => res.redirect(301, `/news/${req.params.category}/`));
  router.get('/news/sitemap.xml', guard(async (req, res) => { const articles = await store.listArticles({ limit: 50000 }); const urls = [{ path: '/news/' }, ...views.publicCategories().map(c => ({ path: `/news/${c.slug}/` })), ...articles.map(a => ({ path: `/news/${a.slug}/`, date: a.updated_at || a.published_at }))]; res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${views.esc(origin() + u.path)}</loc>${u.date ? `<lastmod>${views.esc(u.date)}</lastmod>` : ''}</url>`).join('')}</urlset>`); }));
  router.get('/news/:slug/social.jpg', guard(async (req, res) => { if (!/^[a-z0-9-]{1,110}$/.test(req.params.slug)) return res.status(404).send('Article not found'); const article = await store.articleBySlug(req.params.slug); if (!article) return res.status(404).send('Article not found'); const image = await require('../resources/socialGraphic').renderNewsGraphic(article); res.set('Cache-Control', 'public, max-age=86400').type('image/jpeg').send(image); }));
  router.get('/news/:slug/', guard(async (req, res) => { if (!/^[a-z0-9-]{1,110}$/.test(req.params.slug)) return res.status(404).send('Article not found'); const cat=category(req.params.slug); if(cat&&!['dental','product-launches'].includes(cat.slug)) return res.type('html').send(views.index(await store.listArticles({category:cat.slug}),cat.slug)); const article = await store.articleBySlug(req.params.slug); if (!article) return res.status(404).send('Article not found'); const related = (await store.listArticles({ category: article.category, limit: 4 })).filter(a => a.slug !== article.slug).slice(0, 3); res.type('html').send(views.article(article, related)); }));
  return router;
}
module.exports = { createRouter, redirectNewsRoot };
