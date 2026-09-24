const path=require('path'),fs=require('fs');
const PUBLIC_PATHS=new Set(['/', '/index.html','/rook-browse.html','/rook-about.html','/rook-pricing.html','/rook-employers.html','/rook-companies.html','/rook-privacy.html','/rook-terms.html','/rook-cookies.html']);
const TRACKING=/^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|ref|referral)$/;
function headers(req,res,next) {
  if(/^\/rook-[a-z0-9-]+\.html$/.test(req.path)&&!PUBLIC_PATHS.has(req.path))res.set('X-Robots-Tag','noindex, follow');
  if(req.path.startsWith('/api/')) res.set('X-Robots-Tag','noindex');
  if(PUBLIC_PATHS.has(req.path)&&Object.keys(req.query).some(k=>!TRACKING.test(k))) res.set('X-Robots-Tag','noindex, follow');
  next();
}
function staticHeaders(res,filePath) {
  if(filePath.endsWith('.html')&&!PUBLIC_PATHS.has('/'+path.basename(filePath)))res.setHeader('X-Robots-Tag','noindex, follow');
}
// Add public metadata without duplicating or rewriting large static templates.
// Only a fixed allowlist can reach the filesystem; there is no user-derived path.
const rendered=new Map();
function pages(req,res,next) {
  if(!['GET','HEAD'].includes(req.method)||!PUBLIC_PATHS.has(req.path))return next();
  const file=req.path==='/'?'index.html':req.path.slice(1);
  try {
    if(!rendered.has(file)) {
      let html=fs.readFileSync(path.join(__dirname,'../public',file),'utf8');
      const canonical='https://rookcareers.com/'+(file==='index.html'?'':file);
      if(!html.includes('rel="canonical"'))html=html.replace('</title>','</title>\n<link rel="canonical" href="'+canonical+'">');
      if(file==='index.html') {
        const anchor='<li><a href="/jobs/category/veterinary-sales-jobs">Veterinary Sales Jobs</a></li>';
        const links=[['medical-device-sales-jobs','Medical Device Sales Jobs'],['diagnostics-sales-jobs','Diagnostics &amp; Laboratory Sales Jobs'],['capital-equipment-sales-jobs','Capital Equipment Sales Jobs']];
        html=html.replace(anchor,anchor+links.map(([slug,label])=>'<li><a href="/jobs/category/'+slug+'">'+label+'</a></li>').join(''));
      }
      rendered.set(file,html);
    }
    res.set('Cache-Control','no-cache, no-store, must-revalidate').set('Pragma','no-cache').type('html').send(rendered.get(file));
  }catch(error){next(error);}
}
module.exports={headers,staticHeaders,pages,PUBLIC_PATHS};
