const CATEGORIES = [
 ['medical-device','Medical Device','medical','medical-device-sales-jobs'],
 ['diagnostics-laboratory','Diagnostics & Laboratory','diagnostics','diagnostics-sales-jobs'],
 ['pharmaceutical-biotech','Pharmaceutical & Biotech','pharma','pharmaceutical-sales-jobs'],
 ['veterinary-animal-health','Veterinary & Animal Health','veterinary','veterinary-sales-jobs'],
 ['career-advice','Career Advice / Territory Sales','career','medical-sales-jobs'],
 ['interviews-resumes','Interviews & Resumes','interviews','medical-sales-jobs'],
 ['industry-news','Industry News','news','medical-sales-jobs'],
 ['breaking-into-medical-sales','Breaking Into Medical Sales','breaking','medical-sales-jobs'],
].map(([slug,label,image,jobs])=>({slug,label,image,jobs}));
const category = slug => CATEGORIES.find(c=>c.slug===slug);
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,110);
function imageFor(slug, previous='') {
 const c=category(slug)||CATEGORIES[4];
 const paths=[`/assets/resources/${c.image}.jpg`,`/assets/resources/${c.image}-alt.jpg`];
 return paths.find(p=>p!==previous)||paths[0];
}
const origin = () => (process.env.PUBLIC_APP_URL || 'https://rookcareers.com').replace(/\/$/,'');
const urlFor = slug => `${origin()}/resources/${slug}/`;
module.exports={CATEGORIES,category,slugify,imageFor,origin,urlFor};
