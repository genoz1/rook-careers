// Stateless links for organic posts only. Never used by stored content or SEO.
const ORIGIN = 'https://rookcareers.com';
const DESTINATIONS = {
  facebook: { source: 'facebook' },
  instagram: { source: 'instagram' },
  linkedin: { source: 'linkedin', account: 'rook_linkedin' },
  'gene-linkedin': { source: 'linkedin', account: 'gene_linkedin' },
};
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const SOCIAL_PREVIEW_CRAWLER = /facebookexternalhit|facebot|meta-externalagent|meta-externalfetcher|socialchamp|twitterbot/i;
const SOCIAL_PREVIEW_IMAGE = `${ORIGIN}/assets/rook-social-share.png`;
const FAMILIES = {
  resources: { campaign: 'rook_resources', path: id => `/resources/${id}/` },
  jobs: { campaign: 'rook_jobs', path: id => `/jobs/${id}` },
  matches: { campaign: 'rook_jobs', path: () => '/rook-onboarding-v8.html' },
  home: { campaign: 'rook_jobs', path: () => '/' },
};
function cleanQuery(query) {
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) if (/^utm_/i.test(key)) params.delete(key);
  return params;
}
function resolveShortLink(input) {
  const url = new URL(input, ORIGIN);
  // Manually maintained SocialChamp rotation links use the same redirect
  // and query-cleaning path, with their own campaign and V8 destination.
  const socialChamp = url.pathname.match(/^\/go\/socialchamp\/(facebook|instagram)\/([^/]+)$/);
  if (socialChamp) {
    const [, platform, id] = socialChamp;
    if (!ID.test(id)) throw Error('Invalid SocialChamp content identifier');
    const resolved = new URL('/rook-onboarding-v8.html', ORIGIN);
    resolved.search = cleanQuery(url.search).toString();
    resolved.searchParams.set('utm_source', platform);
    resolved.searchParams.set('utm_medium', 'organic_social');
    resolved.searchParams.set('utm_campaign', 'socialchamp_rotation');
    resolved.searchParams.set('utm_content', id);
    resolved.hash = url.hash;
    return resolved.toString();
  }
  const match = url.pathname.match(/^\/go\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) throw Error('Invalid organic short link');
  const [, destination, family, id] = match;
  const target = DESTINATIONS[destination], content = FAMILIES[family];
  if (!Object.hasOwn(DESTINATIONS, destination) || !Object.hasOwn(FAMILIES, family) || !ID.test(id)) throw Error('Invalid organic short link');
  const resolved = new URL(content.path(id), ORIGIN);
  resolved.search = cleanQuery(url.search).toString();
  for (const [key, value] of Object.entries({
    utm_source: target.source, utm_medium: 'organic_social',
    utm_campaign: content.campaign, utm_content: id,
    ...(target.account ? { utm_source_platform: target.account } : {}),
  })) resolved.searchParams.set(key, value);
  resolved.hash = url.hash;
  return resolved.toString();
}
function shortSocialUrl(input, destination, identifier) {
  if (!Object.hasOwn(DESTINATIONS, destination)) throw Error('Unsupported organic destination');
  const url = new URL(input, ORIGIN);
  if (url.origin !== ORIGIN) throw Error('Organic links must lead to ROOK');
  // Re-target saved personal templates too, without changing accepted posts.
  if (url.pathname.startsWith('/go/')) return shortSocialUrl(resolveShortLink(url), destination);
  let family, id;
  const resource = url.pathname.match(/^\/resources\/([a-z0-9-]{1,110})\/?$/);
  const job = url.pathname.match(/^\/jobs\/([a-zA-Z0-9_-]{1,160})\/?$/);
  if (resource) { family = 'resources'; id = resource[1]; }
  else if (job) { family = 'jobs'; id = job[1]; }
  else if (url.pathname === '/rook-onboarding-v8.html') { family = 'matches'; id = identifier || url.searchParams.get('utm_content') || 'matches'; }
  else if (url.pathname === '/') { family = 'home'; id = identifier || url.searchParams.get('utm_content') || 'careers'; }
  else throw Error('Unsupported organic ROOK page');
  if (!ID.test(id)) throw Error('Invalid organic content identifier');
  const short = new URL(`/go/${destination}/${family}/${id}`, ORIGIN);
  short.search = cleanQuery(url.search).toString();
  short.hash = url.hash;
  return short.toString();
}
function trackSocialText(text, destination) {
  return text.replace(/https:\/\/rookcareers\.com\/[^\s<>"']*/g, raw => {
    const [, link, punctuation] = raw.match(/^(.*?)([.,!;)]*)$/);
    return shortSocialUrl(link, destination) + punctuation;
  });
}
function socialChampPreview(originalUrl) {
  const short = new URL(originalUrl, ORIGIN);
  short.search = cleanQuery(short.search).toString();
  const safeUrl = short.toString().replace(/&/g, '&amp;');
  const title = 'Medical Sales Jobs | ROOK';
  const description = 'Medical and veterinary sales opportunities matched from employer career sites.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<meta property="og:type" content="website"><meta property="og:url" content="${safeUrl}">` +
    `<meta property="og:title" content="${title}"><meta property="og:description" content="${description}">` +
    `<meta property="og:image" content="${SOCIAL_PREVIEW_IMAGE}">` +
    `<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="400">` +
    `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}">` +
    `<meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${SOCIAL_PREVIEW_IMAGE}">` +
    `</head><body></body></html>`;
}
function createRouter() {
  const router = require('express').Router();
  router.use('/go', (req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/go/:destination/:family/:id', (req, res) => {
    try {
      const destination = resolveShortLink(req.originalUrl);
      if (req.params.destination === 'socialchamp' && SOCIAL_PREVIEW_CRAWLER.test(req.get('User-Agent') || '')) {
        res.vary('User-Agent');
        return res.type('html').send(socialChampPreview(req.originalUrl));
      }
      return res.redirect(302, destination);
    }
    catch { return res.status(404).send('Short link not found'); }
  });
  router.use('/go', (req, res) => res.status(404).send('Short link not found'));
  return router;
}
module.exports = { shortSocialUrl, resolveShortLink, trackSocialText, createRouter };
