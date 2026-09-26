const express=require('express');
const {db,result,articles}=require('./store');
const {category,CATEGORIES,origin}=require('./catalog');
const views=require('./views');
function createRouter(deps={}){
 const router=express.Router();
 const client=()=>deps.db||db();
 const listing=deps.articles||articles;
 let loadJobs;
 router.use('/resources',(req,res,next)=>{res.set('Cache-Control','public, max-age=60');next();});
 const guard=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch{res.status(503).set('Retry-After','300').set('Cache-Control','no-store').send('Career Resources are temporarily unavailable. Please try again shortly.');}};
 const list=guard(async(req,res)=>{
  const categorySlug=req.params.category;
  if(categorySlug&&!category(categorySlug))return res.status(404).send('Resource category not found');
  const page=Math.max(1,Math.min(1000,Number.parseInt(req.query.page,10)||1));
  const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,100):'';
  if(q)res.set('X-Robots-Tag','noindex, follow');
  const data=await listing({category:categorySlug,q,page},client());
  if(page>1&&!data.items.length)return res.status(404).send('No more articles');
  // Explicit page=1 means the full article listing, including the featured item.
  res.type('html').send(views.index({...data,categorySlug,q,page,all:req.query.page!==undefined}));
 });
 router.get('/resources',list);
 router.get('/resources/category/:category',list);
 router.get('/resources/sitemap.xml',guard(async(req,res)=>{
  const urls=[{path:'/resources/'},...CATEGORIES.map(c=>({path:'/resources/category/'+c.slug+'/'}))];
  let offset=0;
  while(true){const rows=await result(client().from('resource_articles').select('slug,updated_at').order('slug').range(offset,offset+499));
   if(!rows.length)break;urls.push(...rows.map(a=>({path:'/resources/'+a.slug+'/',date:a.updated_at})));offset+=rows.length;if(offset>49000)throw Error('Sitemap split required');}
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u=>`<url><loc>${views.esc(origin()+u.path)}</loc>${u.date?`<lastmod>${views.esc(u.date)}</lastmod>`:''}</url>`).join('')}</urlset>`);
 }));
 router.get('/resources/:slug/social.jpg',guard(async(req,res)=>{
  if(!/^[a-z0-9-]{1,110}$/.test(req.params.slug))return res.status(404).send('Article not found');
  const a=await result(client().from('resource_articles').select('title,category').eq('slug',req.params.slug).maybeSingle());
  if(!a)return res.status(404).send('Article not found');
  const buffer=await require('./socialGraphic').renderResourceGraphic(a);
  res.set('Cache-Control','public, max-age=86400').type('image/jpeg').send(buffer);
 }));
 router.get('/resources/:slug',guard(async(req,res)=>{
  if(!/^[a-z0-9-]{1,110}$/.test(req.params.slug))return res.status(404).send('Article not found');
  const a=await result(client().from('resource_articles').select('*').eq('slug',req.params.slug).maybeSingle());
  if(!a)return res.status(404).send('Article not found');
  const related=(await listing({category:a.category,limit:5},client())).items.filter(r=>r.slug!==a.slug).slice(0,4);
  let jobs=[];
  try{const inventory=await (deps.jobs||(loadJobs ||= require('../seoInventory').createInventoryLoader(client())))();jobs=inventory['/jobs/category/'+category(a.category).jobs]?.entries?.slice(0,3)||[];}catch{/* Job availability must not block a public article. */}
  res.type('html').send(views.article(a,related,jobs));
 }));
 return router;
}
module.exports={createRouter};
