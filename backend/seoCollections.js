const {CATEGORIES,FLORIDA} = require('./seoInventory');
const PAGE_SIZE=30;
function pageNumber(query) {
  const value=query.page===undefined?'1':query.page;
  return typeof value==='string'&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
}
function hasFilters(query) {
  return Object.keys(query).some(k=>k!=='page'&&!/^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|ref|referral)$/.test(k));
}
function createCollectionHandler({loadInventory,pageShell,escapeHtml:e,baseUrl}) {
  return async function(req,res) {
    const {slug,state}=req.params;
    if(!CATEGORIES[slug]||(state&&(!FLORIDA.includes(slug)||state!=='florida')))return res.status(404).send('Page not found.');
    const page=pageNumber(req.query);if(!page)return res.status(404).send('Page not found.');
    try {
      const all=await loadInventory(),path='/jobs/category/'+slug+(state?'/florida':''),c=all[path];
      const pages=Math.max(1,Math.ceil(c.count/PAGE_SIZE));if(page>pages)return res.status(404).send('Page not found.');
      const pagePath=n=>path+(n>1?'?page='+n:'');
      const canonicalUrl=baseUrl+pagePath(page),suffix=page>1?' — Page '+page:'';
      const title=c.label+suffix+' | ROOK';
      const description=`Browse ${c.count} current ${c.label.toLowerCase()}${page>1?'; page '+page:''}. Compare masked role previews${state?' located in Florida or covering Florida territories':''}. Start a trial for full job details.`;
      const crumbs=[{name:'Home',url:baseUrl+'/'}];
      if(state)crumbs.push({name:CATEGORIES[slug].label,url:baseUrl+'/jobs/category/'+slug});
      crumbs.push({name:state?'Florida':c.label,url:baseUrl+path});
      if(page>1)crumbs.push({name:'Page '+page,url:canonicalUrl});
      const visible=c.entries.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE);
      const categoryLinks=Object.keys(CATEGORIES).filter(s=>s!==slug).map(s=>`<a href="/jobs/category/${s}">${e(CATEGORIES[s].label)}</a>`);
      const floridaLinks=FLORIDA.filter(s=>all['/jobs/category/'+s+'/florida']?.qualified && (!state||s!==slug)).map(s=>`<a href="/jobs/category/${s}/florida">${e(CATEGORIES[s].label)} in Florida</a>`);
      const scopeCopy=state?'<p>Includes validated Florida locations and territories explicitly covering Florida. Nationwide and generic remote jobs are excluded. A territory covering Florida does not necessarily mean the role is based in a Florida city.</p>':'';
      const card=job=>`<article class="seo-card"><h2><a href="${e(job.url)}">${e(job.title)}</a></h2><p>${e([job.labels.join(' · '),job.role,job.employment,job.freshness].filter(Boolean).join(' · '))}</p>${state?`<p>${job.floridaKind==='territory'?'Territory covering Florida':'Validated Florida location'}${job.floridaKind==='local'&&job.location?.endsWith(', FL')?', preview location: '+e(job.location):''}</p>`:job.location?`<p>${e(job.location)}</p>`:''}<a class="seo-detail" href="${e(job.url)}">View masked job preview →</a></article>`;
      const bodyHtml=`<style>.seo-breadcrumb,.seo-links{display:flex;flex-wrap:wrap;gap:10px;line-height:1.6;margin:0 0 22px}.seo-breadcrumb a,.seo-links a,.seo-detail{color:var(--royal);text-decoration:underline;text-underline-offset:3px}.seo-intro{line-height:1.75;margin:18px 0}.seo-intro p{margin:12px 0}.seo-card{background:white;border:1px solid var(--border);border-radius:14px;padding:20px;margin:14px 0}.seo-card h2{font-size:19px;line-height:1.4}.seo-card p{color:var(--muted);line-height:1.7;margin:10px 0}.seo-section{margin-top:30px}.seo-section h2{font-size:20px;margin-bottom:12px}.seo-pagination{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;margin:24px 0}.seo-actions{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}</style>
        <nav class="seo-breadcrumb" aria-label="Breadcrumb">${crumbs.map((x,i)=>i===crumbs.length-1?`<span aria-current="page">${e(x.name)}</span>`:`<a href="${e(x.url)}">${e(x.name)}</a><span aria-hidden="true">›</span>`).join('')}</nav>
        <h1>${e(c.label+suffix)}</h1><div class="seo-intro"><p>${e(c.intro)}</p>${scopeCopy}<p><strong data-job-count="${c.count}">${c.count} current matching jobs</strong>. Counts cover distinct active, approved US-eligible listings and refresh at least every minute. Availability can change.</p><p>These are masked previews. Employer identity, complete job details and application links remain locked until your trial.</p></div>
        <div class="seo-actions"><a class="btn btn-primary" href="/rook-onboarding-v7.html">Start your 3-day free trial</a><a class="btn btn-outline" href="/rook-browse.html">Search jobs near your ZIP code</a></div>
        ${!c.qualified?'<p>This collection currently has limited inventory. Browse the related national categories below for more opportunities.</p>':''}
        <section aria-label="Current job previews"><h2>Current job previews</h2><p data-page-count="${visible.length}">${c.count?'Showing '+((page-1)*PAGE_SIZE+1)+'–'+Math.min(page*PAGE_SIZE,c.count)+' of '+c.count:'No matching jobs right now.'}</p>${visible.map(card).join('')}</section>
        <nav class="seo-pagination" aria-label="Job result pages">${page>1?`<a class="btn btn-outline" href="${pagePath(page-1)}">Previous page</a>`:''}<span>Page ${page} of ${pages}</span>${page<pages?`<a class="btn btn-outline" href="${pagePath(page+1)}">Next page</a>`:''}</nav>
        ${state?`<p><a class="seo-detail" href="/jobs/category/${slug}">Browse all ${e(CATEGORIES[slug].label.toLowerCase())}</a></p>`:''}
        ${floridaLinks.length?`<section class="seo-section"><h2>Explore Florida opportunities</h2><nav class="seo-links" aria-label="Florida categories">${floridaLinks.join('')}</nav></section>`:''}
        <section class="seo-section"><h2>Related sales categories</h2><nav class="seo-links" aria-label="Related categories">${categoryLinks.join('')}</nav></section>`;
      const jsonLd={'@context':'https://schema.org','@graph':[
        {'@type':'CollectionPage','@id':canonicalUrl+'#collection',url:canonicalUrl,name:c.label+suffix,description},
        {'@type':'BreadcrumbList',itemListElement:crumbs.map((x,i)=>({'@type':'ListItem',position:i+1,name:x.name,item:x.url}))}
      ]};
      return res.send(pageShell({title,description,canonicalUrl,bodyHtml,jsonLd,noindex:!c.qualified||hasFilters(req.query)}));
    } catch(error) {return res.status(503).set('Retry-After','60').send('Job collection temporarily unavailable. Please try again shortly.');}
  };
}
module.exports={PAGE_SIZE,pageNumber,hasFilters,createCollectionHandler};
