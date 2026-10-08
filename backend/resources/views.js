const {CATEGORIES,category,origin,urlFor}=require('./catalog');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'America/New_York'});
const PREFER_LABEL={
 'medical-device':'Medical Device',
 'diagnostics-laboratory':'Diagnostics',
 'pharmaceutical-biotech':'Pharmaceutical',
 'veterinary-animal-health':'Veterinary',
};
const NEWS_JOB_PATH={
 'medical-device':'medical-device-sales-jobs',
 'diagnostics-laboratory':'diagnostics-sales-jobs',
 'pharmaceutical-biotech':'pharmaceutical-sales-jobs',
 'veterinary-animal-health':'veterinary-sales-jobs',
};
function onboardingHref(source,content){
 const params=new URLSearchParams({utm_source:source,utm_medium:'article',utm_campaign:'open_roles',utm_content:String(content||'article').slice(0,80)});
 return `/rook-onboarding-v8.html?${params}`;
}
function cta({source='resources',content='cta',browseHref='/jobs',browseLabel='Browse open role previews →'}={}){
 const href=onboardingHref(source,content);
 return `<aside class="resource-cta"><span class="case-icon" aria-hidden="true">▣</span><h2>Looking for your next<br>sales opportunity?</h2><p>See live medical and veterinary sales openings on ROOK. Membership unlocks employers, full details, and applications.</p><a class="button" data-resource-event="resource_find_matches_click" href="${esc(href)}">Find My Matches <span>→</span></a><a class="browse-link" data-resource-event="resource_job_click" href="${esc(browseHref)}">${esc(browseLabel)}</a></aside>`;
}
function jobsPanel({label='medical & veterinary sales',jobsPath='/jobs',source='resources',content='article',prefer='',variant=''}={}){
 const heading=`Open ${label} roles`;
 const href=onboardingHref(source,`${content}-jobs`);
 const id=variant==='inline'?'article-open-roles':undefined;
 return `<section${id?` id="${id}"`:''} class="article-jobs related-jobs${variant?` article-jobs-${variant}`:''}" aria-labelledby="article-jobs-heading-${esc(variant||'main')}" data-article-jobs data-jobs-path="${esc(jobsPath)}" data-jobs-source="${esc(source)}" data-jobs-content="${esc(content)}" data-jobs-prefer="${esc(prefer)}"><h2 id="article-jobs-heading-${esc(variant||'main')}">${esc(heading)}</h2><p class="article-jobs-lead">Live previews from employer career sites. Unlock the employer and apply with ROOK membership.</p><div class="article-jobs-list" data-article-jobs-list><a class="article-jobs-fallback" data-resource-event="resource_job_click" href="${esc(jobsPath)}">Browse current job previews →</a></div><a class="button article-jobs-cta" data-resource-event="resource_find_matches_click" href="${esc(href)}">See matches for my background <span>→</span></a></section>`;
}
function jobContext(categorySlug,source='resources',content='article'){
 const c=category(categorySlug);
 const jobsPath=c?`/jobs/category/${c.jobs}`:`/jobs`;
 // Industry categories keep a specific label; advice/interview guides stay
 // general so the module reads as open roles, not "Career Advice jobs".
 const label=PREFER_LABEL[categorySlug]
  || (c && ['medical-device','diagnostics-laboratory','pharmaceutical-biotech','veterinary-animal-health'].includes(c.slug)
    ?(c.label.includes('/')?c.label.split('/')[0].trim():c.label)
    :'Medical & Veterinary Sales');
 const prefer=PREFER_LABEL[categorySlug]||'';
 return {label,jobsPath,source,content,prefer};
}
function card(a,featured=false){return `<article class="article-card ${featured?'featured':''}"><a class="card-image" href="/resources/${esc(a.slug)}/"><img src="${esc(a.image_path)}" alt="${esc(a.image_alt)}" ${featured?'':'loading="lazy"'}>${featured?'<span class="feature-badge">FEATURED ARTICLE</span>':''}</a><div class="card-content"><a class="eyebrow" href="/resources/category/${esc(a.category)}/">${esc(category(a.category)?.label)}</a><h${featured?'2':'3'}><a href="/resources/${esc(a.slug)}/">${esc(a.title)}</a></h${featured?'2':'3'}>${featured?`<p class="excerpt">${esc(a.description)}</p>`:''}<div class="meta"><span>▦ ${date(a.published_at)}</span><span>◷ ${Math.max(1,Math.ceil(a.word_count/220))} min read</span></div><a class="read-link ${featured?'button':''}" href="/resources/${esc(a.slug)}/">Read Article <span>→</span></a></div></article>`;}
function shell({title,description,path,body,image='/assets/resources/hero.jpg',article,schema,section='resources',bodyAttributes='',noindex=false}){
 const url=origin()+path;
 const structured=schema||(article?[
 {'@context':'https://schema.org','@type':'Article',headline:article.title,description:article.description,image:origin()+image,datePublished:article.published_at,dateModified:article.updated_at,mainEntityOfPage:url,author:{'@type':'Organization',name:'ROOK',url:origin()},publisher:{'@type':'Organization',name:'ROOK',url:origin()}},
 {'@context':'https://schema.org','@type':'BreadcrumbList',itemListElement:[{name:'Resources',item:origin()+'/resources/'},{name:category(article.category).label,item:origin()+'/resources/category/'+article.category+'/'},{name:article.title,item:url}].map((x,i)=>({'@type':'ListItem',position:i+1,...x}))}]:null);
 const resourceActive=section==='resources',newsActive=section==='news';
 const published=article?.published_at,modified=article?.updated_at||published;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | ROOK</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(url)}">${noindex?'<meta name="robots" content="noindex,follow">':''}<meta property="og:type" content="${article?'article':'website'}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(origin()+image)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(origin()+image)}">${article?`<meta property="article:published_time" content="${esc(published)}"><meta property="article:modified_time" content="${esc(modified)}">`:''}<link rel="icon" href="/assets/favicon.ico"><link rel="stylesheet" href="/resources.css"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">${structured?`<script type="application/ld+json">${JSON.stringify(structured).replace(/</g,'\\u003c')}</script>`:''}<script src="/rook-attribution.js"></script><script async src="https://www.googletagmanager.com/gtag/js?id=AW-18428232873"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','AW-18428232873');gtag('config','G-LDG2CL5Z8R');</script><script src="/resources.js" defer></script></head><body ${article&&section==='resources'?`data-resource-slug="${esc(article.slug)}"`:''} ${bodyAttributes}><a class="skip" href="#main">Skip to content</a><header><div class="nav-inner"><a href="/" aria-label="ROOK home"><img class="logo" src="/assets/rook-full-logo-480.png" alt="ROOK Medical & Veterinary Sales Jobs"></a><button class="menu-toggle" aria-controls="resource-nav" aria-expanded="false" aria-label="Open navigation">☰</button><nav id="resource-nav" aria-label="Main navigation"><a href="/">Home</a><a href="/rook-onboarding-v8.html">Find Jobs</a><a data-resource-event="resource_find_matches_click" href="/rook-onboarding-v8.html">Find My Matches</a><a href="/rook-employers.html">Employers</a><a ${resourceActive?'class="active" aria-current="page" ':''}href="/resources/">Resources</a><a ${newsActive?'class="active" aria-current="page" ':''}href="/news/">Industry News</a><a href="/rook-about.html">About</a><a class="button outline" href="/rook-login.html">Sign In</a><a class="button" data-resource-event="resource_find_matches_click" href="/rook-onboarding-v8.html">Get Started</a></nav></div></header><main id="main">${body}</main><footer><a href="/">ROOK</a><span>Medical & Veterinary Sales Jobs</span><a href="/resources/">Resources</a><a href="/news/">Industry News</a><a href="/rook-privacy.html">Privacy</a><a href="/rook-terms.html">Terms</a></footer></body></html>`;
}
function index({items,count,categorySlug,q='',page=1,all=false}){
 const c=category(categorySlug);const home=!c&&!q&&page===1&&!all;
 const title=c?c.label:q?'Search Career Resources':'ROOK Career Resources';
 const search=`<form role="search" action="${c?'/resources/category/'+c.slug+'/':'/resources/'}"><label class="sr-only" for="resource-search">Search articles, topics or keywords</label><span aria-hidden="true">⌕</span><input id="resource-search" name="q" value="${esc(q)}" placeholder="Search articles, topics or keywords..." maxlength="100"><button>Search</button></form>`;
 const categories=`<section class="categories" aria-label="Resource categories">${CATEGORIES.slice(0,7).map(c=>`<a class="category-card" href="/resources/category/${c.slug}/"><img src="/assets/resources/${c.image}.jpg" alt="" loading="lazy"><span>${esc(c.label==='Career Advice / Territory Sales'?'Career Advice':c.label)}<b>→</b></span></a>`).join('')}</section>`;
 const feature=home&&items.length?`<div class="section-heading mobile-feature-title"><h2>Featured Article</h2></div><div class="feature-grid">${card(items[0],true)}${cta({source:'resources',content:'resources-home',browseHref:'/rook-onboarding-v8.html',browseLabel:'Find roles that fit my background →'})}</div>`:'';
 const shown=home?items.slice(1):items;
 const pageUrl=p=>`${c?'/resources/category/'+c.slug+'/':'/resources/'}?${new URLSearchParams({...q?{q}:{},page:p})}`;
 const body=`<section class="hero"><div class="hero-inner"><p class="hero-label">ROOK CAREER RESOURCES</p><h1>${home?'Insights for Medical &amp; <br>Veterinary Sales Professionals':esc(title)}</h1><p>Career guides, industry insights and practical advice to help you<br class="desktop-only"> build a successful career in medical, animal health and related sales.</p>${search}</div></section><div class="container">${categories}${feature}<section><div class="section-heading"><h2>${home?'Latest Articles':esc(title)}</h2>${home?'<a href="/resources/?page=1">View All Articles →</a>':''}</div><div class="article-grid">${shown.map(a=>card(a)).join('')}</div>${!items.length?'<div class="empty"><h2>Career resources are on the way</h2><p>Explore our categories or browse current sales opportunities.</p><a href="/jobs">Browse Jobs →</a></div>':''}<nav class="pagination" aria-label="Article pages">${page>1?`<a href="${esc(pageUrl(page-1))}">← Previous</a>`:''}${count>page*12?`<a href="${esc(pageUrl(page+1))}">Next →</a>`:''}</nav></section><section class="topics"><h2>Popular Topics</h2><div>${CATEGORIES.filter(c=>c.slug!=='industry-news').map(c=>`<a href="/resources/category/${c.slug}/">${esc(c.label)} →</a>`).join('')}<a href="/resources/?q=territory">Territory Management →</a></div></section></div>`;
 return shell({title,description:'Career guides, industry insights and practical advice for medical and veterinary sales professionals.',path:(c?'/resources/category/'+c.slug+'/':'/resources/')+(page>1?'?page='+page:''),body,noindex:!!q});
}
function article(a,related=[],_jobs=[]){
 const c=category(a.category);
 const recommendations=[...new Map(related.filter(r=>r.slug!==a.slug).map(r=>[r.slug,r])).values()].slice(0,3);
 const relatedSection=`<section class="related-jobs" aria-labelledby="related-resources-heading"><h2 id="related-resources-heading">Related Resources</h2>${recommendations.length?recommendations.map(r=>`<a href="/resources/${esc(r.slug)}/">${esc(r.title)} →</a>`).join(''):'<p>More guides in this category will appear here as they are published.</p>'}</section>`;
 const jobs=jobContext(a.category,'resources',a.slug);
 // Live role cards hydrate client-side from the slim public featured API so
 // article HTML never waits on the SEO job inventory rebuild. Placed after
 // the hero so readers see openings before a long guide.
 const openRoles=jobsPanel({...jobs,variant:'inline'});
 const articleCta={source:'resources',content:a.slug,browseHref:'#article-open-roles',browseLabel:'See open roles on this page →'};
 const body=`<div class="container article-layout"><article class="article-body"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/resources/">Resources</a> / <a href="/resources/category/${c.slug}/">${esc(c.label)}</a></nav><p class="eyebrow">${esc(c.label)}</p><h1>${esc(a.title)}</h1><p class="dek">${esc(a.description)}</p><div class="meta"><span>By ROOK Career Resources</span><time datetime="${esc(a.published_at)}">${date(a.published_at)}</time><span>${Math.ceil(a.word_count/220)} min read</span></div><img class="article-hero" src="${esc(a.image_path)}" alt="${esc(a.image_alt)}">${openRoles}<div class="prose">${a.body_html}</div><p class="updated">Updated ${date(a.updated_at)}</p><section class="sources"><h2>Sources & further reading</h2><ul>${a.sources.map(s=>`<li><a href="${esc(s.url)}" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join('')}</ul></section>${relatedSection}<div class="article-footer-cta">${cta(articleCta)}</div></article><div class="article-sidebar">${cta({...articleCta,content:`${a.slug}-side`,browseHref:jobs.jobsPath,browseLabel:'Browse category job previews →'})}${jobsPanel({...jobs,variant:'sidebar'})}</div></div>`;
 return shell({title:a.title,description:a.description,path:'/resources/'+a.slug+'/',body,image:a.image_path,article:a});
}
module.exports={esc,index,article,shell,cta,jobsPanel,jobContext,onboardingHref,NEWS_JOB_PATH,PREFER_LABEL};
