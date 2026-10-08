'use strict';
const { CATEGORIES, category } = require('./catalog');
const { origin } = require('../resources/catalog');
const resourceViews = require('../resources/views');
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const publicCategories = () => CATEGORIES.filter(item => !['dental', 'product-launches'].includes(item.slug));
const displayLabels = Object.freeze({ 'ma-funding': 'M&A / Funding / Partnerships' });
function label(slug) { return displayLabels[slug] || category(slug)?.label || String(slug || 'Industry News').replace(/-/g, ' '); }
const categoryImages = Object.freeze({
  'medical-device': 'medical', 'diagnostics-laboratory': 'diagnostics',
  'pharmaceutical-biotech': 'pharma', 'veterinary-animal-health': 'veterinary',
  'healthcare-technology': 'career', 'fda-regulatory': 'breaking',
  'ma-funding': 'news', 'commercial-sales': 'interviews',
});
const displayDate = value => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00Z` : value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
function shell(options) { return resourceViews.shell({ ...options, section: 'news' }); }
function card(item) {
  const href = `/news/${esc(item.slug)}/`;
  return `<article class="article-card news-card"><a class="card-image" href="${href}"><img src="${href}social.jpg" alt="" loading="lazy"></a><div class="card-content"><a class="eyebrow" href="/news/${esc(item.category)}/">${esc(label(item.category))}</a><h3><a href="${href}">${esc(item.title)}</a></h3><p class="excerpt">${esc(item.description)}</p><div class="meta"><time datetime="${esc(item.published_at)}">▦ ${esc(displayDate(item.published_at))}</time></div><a class="read-link" href="${href}">Read Article <span>→</span></a></div></article>`;
}
function index(items = [], selected = null) {
  const title = selected ? label(selected) : 'Industry News';
  const path = selected ? `/news/${selected}/` : '/news/';
  const categories = publicCategories().map(item => `<a class="category-card${selected === item.slug ? ' selected' : ''}" href="/news/${item.slug}/"${selected === item.slug ? ' aria-current="page"' : ''}><img src="/assets/resources/${categoryImages[item.slug]}.jpg" alt="" loading="lazy"><span>${esc(label(item.slug))}<b>→</b></span></a>`).join('');
  const body = `<section class="hero news-hero"><div class="hero-inner"><p class="hero-label">ROOK INDUSTRY NEWS</p><h1>${esc(title)}</h1><p>Stay current on the companies, products, approvals and industry moves shaping medical sales.</p></div></section><div class="container news-container"><nav class="categories news-categories" aria-label="Industry News categories">${categories}</nav><section aria-labelledby="latest-news-heading"><div class="section-heading"><h2 id="latest-news-heading">${selected ? esc(title) : 'Latest Industry News'}</h2>${selected ? '<a href="/news/">View All Industry News →</a>' : ''}</div><div class="article-grid news-grid">${items.map(card).join('')}</div>${items.length ? '' : '<div class="empty"><h2>No published stories yet</h2><p>Check back for verified industry developments.</p></div>'}</section></div>`;
  return shell({ title, description: 'Current medical, veterinary and life-sciences industry developments for sales professionals.', path, body });
}
function article(item, related = []) {
  const path = `/news/${item.slug}/`, canonical = `${origin()}${path}`, image = `${path}social.jpg`;
  const sources = (item.sources || []).map(source => `<li><a href="${esc(source.url)}" rel="nofollow noopener noreferrer">${esc(source.publisher || source.title || 'Original source')}</a>${source.published_at ? ` — ${esc(displayDate(source.published_at))}` : ''}</li>`).join('');
  const schema = [
    { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: item.title, description: item.description, datePublished: item.published_at, dateModified: item.updated_at || item.published_at, mainEntityOfPage: canonical, image: [`${origin()}${image}`], author: { '@type': 'Organization', name: 'ROOK Industry News', url: `${origin()}/news/` }, publisher: { '@type': 'Organization', name: 'ROOK Careers', url: origin() } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Industry News', item: `${origin()}/news/` },
      { '@type': 'ListItem', position: 2, name: label(item.category), item: `${origin()}/news/${item.category}/` },
      { '@type': 'ListItem', position: 3, name: item.title, item: canonical },
    ] },
  ];
  const resourceCategory = ['medical-device','diagnostics-laboratory','pharmaceutical-biotech','veterinary-animal-health'].includes(item.category) ? item.category : null;
  const relatedSection = related.length ? `<section class="news-related" aria-labelledby="related-news-heading"><div class="section-heading"><h2 id="related-news-heading">Related Industry News</h2></div><div class="article-grid news-grid">${related.map(card).join('')}</div></section>` : '';
  const jobsPath = `/jobs/category/${resourceViews.NEWS_JOB_PATH[item.category] || 'medical-sales-jobs'}`;
  const prefer = resourceViews.PREFER_LABEL[item.category] || '';
  const jobsLabel = resourceCategory ? label(item.category) : 'medical & veterinary sales';
  const jobsOpts = { label: jobsLabel, jobsPath, source: 'news', content: item.slug, prefer };
  const inlineJobs = resourceViews.jobsPanel({ ...jobsOpts, variant: 'inline' });
  const sideJobs = resourceViews.jobsPanel({ ...jobsOpts, variant: 'sidebar' });
  const articleCta = { source: 'news', content: item.slug, browseHref: '#article-open-roles', browseLabel: 'See open roles on this page →' };
  const body = `<div class="container article-layout news-article-layout"><article class="article-body"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/news/">Industry News</a> / <a href="/news/${esc(item.category)}/">${esc(label(item.category))}</a></nav><p class="eyebrow">${esc(label(item.category))}</p><h1>${esc(item.title)}</h1><p class="dek">${esc(item.description)}</p><div class="meta"><span>By ROOK Industry News</span><time datetime="${esc(item.published_at)}">${esc(displayDate(item.published_at))}</time></div><img class="article-hero" src="${image}" alt="${esc(item.image_alt || `${item.title} industry news graphic`)}">${inlineJobs}<div class="prose">${item.body_html}</div>${resourceCategory ? `<p class="news-resource-link"><a href="/resources/category/${resourceCategory}/">Explore related ROOK career guides →</a></p>` : ''}<section class="sources"><h2>Sources</h2><ul>${sources}</ul></section>${relatedSection}<div class="news-mobile-cta">${resourceViews.cta(articleCta)}</div></article><div class="article-sidebar">${resourceViews.cta({ ...articleCta, content: `${item.slug}-side`, browseHref: jobsPath, browseLabel: 'Browse category job previews →' })}${sideJobs}</div></div>`;
  return shell({ title: item.title, description: item.description, path, image, schema, article: item, body });
}
function adminReport(report) { const rows = report.candidates.map(c => { const sources=(c.sources||[]).map(s=>`<a href="${esc(s.url)}" rel="noreferrer">${esc(s.name)}</a>${s.byline?` — By ${esc(s.byline)}`:''}`).join('<br>'); return `<tr><td>${esc(c.headline)}</td><td>${esc(c.category)}</td><td>${esc(c.eventType)}</td><td>${sources}</td><td>${esc(c.relevanceStatus)}</td></tr>`; }).join(''); return `<!doctype html><html><head><meta name="robots" content="noindex,nofollow"><title>Industry News candidate report</title></head><body><h1>Industry News candidate report</h1><pre>${esc(JSON.stringify(report.run?.metrics || {}, null, 2))}</pre><table><tr><th>Headline</th><th>Category</th><th>Event</th><th>Sources</th><th>Status</th></tr>${rows}</table></body></html>`; }
module.exports = { esc, shell, index, article, adminReport, publicCategories };
