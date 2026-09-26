// Presentation only: never write these values back to jobs or scoring snapshots.
// A vocabulary of role/specialty language is safer than a growing blacklist of
// product names: unknown brands are withheld even before we have seen them.
const WORDS = new Set(`
account accounts executive executives sales sale representative representatives rep reps manager
management managing director associate assistant senior sr junior jr lead leader leadership
principal regional region territory territories district area national global international local
remote field inside outside clinical medical device devices pharmaceutical pharmaceuticals pharma
veterinary veterinarian vet animal pet health healthcare care diagnostic diagnostics molecular
precision oncology hematology neurology neurological neuroscience neurovascular neuropsych
immunology dermatology rheumatology endocrinology endocrine diabetes cardiovascular cardiac
cardiology coronary vascular arterial peripheral structural heart rhythm renal kidney nephrology
pulmonary respiratory gastroenterology gastrointestinal gi urology surgical surgery surgeon
orthopedic orthopaedic orthopedics orthopaedics trauma spine spinal extremities foot ankle joint
replacement sports medicine dental oral vision eye eyecare ophthalmology otolaryngology audiology
hearing nutrition nutritional pediatric pediatrics adult neonatal prenatal maternal reproductive
fertility womens women's men mens men's breast cancer solid tumor head neck pain rare disease
diseases infectious infection anti infectives anti-infectives allergy allergies asthma cystic
fibrosis schizophrenia psychiatry psychiatric mental behavioral sleep wound ostomy continence
critical acute post outpatient inpatient hospital hospitals laboratory lab labs research science
sciences scientific technical technology technologies digital robotics robotic imaging ultrasound
radiology radiography magnetic resonance mri ct nuclear endoscopy endoscopic electrophysiology ep
crm cpt teer laao mrd gu iv ivd point of service services customer client clients customers
commercial strategic strategy business development develop specialist specialists specialty
speciality special professional consultant consulting consultation coordinator support operations
operational product products portfolio program project market marketing access reimbursement payer
payor insurance claims billing broker channel distribution distributor distributors supply chain
logistics procurement inventory equipment instruments instrumentation instrument solutions solution
systems system software platform application applications implementation education educator training
trainer trainee intern internship graduate analyst engineer engineering scientist nursing nurse
registered pharmacist pharmacy regulatory quality compliance safety testing test data information
informatics coding authorization recruitment recruiter talent human resources finance financial
legal counsel contracts contract purchasing category indirect direct enterprise named key major
priority community small office physician physicians provider providers practice physician's
physician’s partnership partner partners post-acute ambulatory monitoring monitor vessel closure
prevention treatment therapy therapies therapeutic therapeutics infusion dialysis home building long
term general multispecialty primary secondary public private government federal institutional
institution vice president vp avp rvp svp evp chief officer staff team group division divisional
innovation innovative advanced early enablement engagement retention acquisition transition transfer
travel traveling part time full temporary permanent hybrid per diem bilingual trilingual english
spanish french german korean japanese chinese mandarin speaking covered coverage multiple multi
state statewide city county counties metro metropolitan north south east west northern southern
eastern western central northeast northwest southeast southwest northeastern northwestern
southeastern southwestern midwest midwestern upper lower coastal gulf coast pacific atlantic
mountain mid at near in for and or the with a an to on i ii iii v 1 2 3 4 5 us usa united states
america americas new england mid-atlantic
`.trim().split(/\s+/));
for (const word of `
hereditary risk cardiorenal cns adhd uro gyn hem ua exec prin corporate asc inbound telesales
radiotherapy image guided igs environment supervisor bdr developer architect architecture owner
technician ambassador student university associates specialists accountmanager dir mba aesthetic
aesthetics emergency fire ems screening medtech expert family donor egg myeloma metabolic metabolism
neuropsychiatry neuropsychiatric tissue transplantation transplant rehabilitation rehab
interventional intervention interventions endovascular endourology neuromodulation continence
bladder ablation electrophysiologist mobility biologics biopharma biopharmaceutical bioscience
biotechnology musculoskeletal instrumentation women's women men gastrointestinal genetics genetic
genomics genomic sequencing cytology pathology histology histopathology microbiology microbiological
immunoassay toxicology toxicological hematologic haematology coagulation thrombosis thromboembolism
hemostasis infection prevention sterilization sterile ventilation oxygen anesthesia anaesthesia
anesthesiology nutritionist dietitian diabetes obesity endocrine bariatric audiology otology
cochlear vestibular catheter catheters stent stents endoscopic visualization preservation
transfusion blood plasma cell cellular gene therapy patient centered patient-centered recruitment
recruiting postdoctoral fellow fellowship therapist physical occupational speech behavioral health
counselor social welfare ltc hct ots osa so ne nw se sw al ak az ar ca co ct de fl ga hi id il in ia
ks ky la me md ma mi mn ms mo mt nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi
wy dc
`.trim().split(/\s+/)) WORDS.add(word);
const zipcodes = require('zipcodes');
const cityStates = new Map();
for (const place of Object.values(zipcodes.codes)) {
  const key = place.city.toLowerCase();
  if (!cityStates.has(key)) cityStates.set(key, new Set());
  cityStates.get(key).add(place.state);
}
for (const state of Object.keys(zipcodes.states.full)) state.toLowerCase().split(/\s+/).forEach(w => WORDS.add(w));
const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokens = s => String(s || '').toLowerCase().match(/[a-z]+(?:['’][a-z]+)?|\d+/g) || [];
function clean(s) {
  return s.replace(/,\s*(?=\()/g,' ').replace(/\(\s*\)/g,'').replace(/\s*[,|;:–—-]+\s*(?=[,|;:–—-]|$)/g,' ')
    .replace(/^[\s,|;:–—-]+|[\s,|;:–—-]+$/g,'').replace(/\s+([,)])/g,'$1').replace(/\(\s+/g,'(')
    .replace(/\(\s*[,/ .&-]*\)/g,'').replace(/\[\s*\]/g,'').replace(/\s{2,}/g,' ').replace(/^[\s,|;:–—.\/$&-]+|[\s,|;:–—.\/$&-]+$/g,'').trim();
}
function maskedTitle(job, value = job.title_original || job.title_normalized) {
  let title = String(value || '').replace(/<[^>]*>/g,' ').replace(/&amp;/gi,'&');
  // Remove whole employer clauses, including brand divisions after the name.
  for (const name of [job.company_name, job.recruiter_company]) {
    if (!name) continue;
    title = title.replace(new RegExp(`(?:\\s*[–—|\\-]\\s*|\\()${escape(name)}[^()]*\\)?$`,'i'),'');
    title = title.replace(new RegExp(escape(name),'gi'),' ');
    for (const word of tokens(name)) {
      if (word.length > 2 && !WORDS.has(word)) title = title.replace(new RegExp(`\\b${escape(word)}\\b`,'gi'),' ');
    }
  }
  title = title.replace(/this employer[^()]*$/i,'').replace(/\b\S+[®™]\S*/g,' ')
    .replace(/\[[^\]]*\]/g,'').replace(/https?:\/\/\S+|www\.\S+|\S+@\S+/gi,' ');
  // Geography is supported by the job's own location fields, not inferred from
  // an unfamiliar title token (which could be a product). It stays readable.
  const geography = new Set(tokens([job.city,job.state,job.location_raw].filter(Boolean).join(' ')));
  const state = String(job.state || '').toUpperCase();
  const stateCode = state.length === 2 ? state : zipcodes.states.full[state];
  for (const part of title.split(/[()–—]|\s-\s/)) {
    const places = part.trim().split(/\s*\/\s*/);
    if (places.length > 1 && places.every(p=>cityStates.has(p.toLowerCase()))) {
      tokens(part).forEach(w=>geography.add(w));
    } else if (cityStates.get(part.trim().toLowerCase())?.has(stateCode)) {
      tokens(part).forEach(w=>geography.add(w));
    }
  }
  // City + state territory clauses are useful even when the source city field
  // is empty. Require a state code and no role words before accepting one.
  for (const part of title.split(/[()–—]|\s-\s/)) {
    if (/^[a-z ./'&-]+,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s*$/i.test(part.trim()) && !/sales|account|manager|specialist|representative/i.test(part)) {
      tokens(part).forEach(word => geography.add(word));
    }
  }
  // Drop an unsupported parenthetical as a unit rather than leaving fragments.
  title = title.replace(/\(([^)]*)\)/g,(all,inner) => tokens(inner).every(w=>WORDS.has(w)||geography.has(w)) ? all : '');
  title = title.replace(/[a-z]+(?:['’][a-z]+)?|\d+/gi, word => WORDS.has(word.toLowerCase()) || geography.has(word.toLowerCase()) ? word : '');
  title = clean(title.replace(/\b(?:in|for|and|or|of|with|at)\s*(?=[,;:–—)\-]|$)/g,'').replace(/(?:\s*&\s*)+(?=[,)–—]|$)/g,''));
  return title && /\b(sales|account|manager|specialist|director|representative|consultant|executive|associate|engineer|scientist|nurse|lead|officer|analyst|coordinator|support|intern|educator|president|vp|dir|leader|developer|architect|owner|technician|ambassador|specialists|associates|accountmanager|supervisor|bdr)\b/i.test(title) ? title : 'Sales opportunity';
}
const SAFE_ROLE_PREFIXES = new Set(`
clinical veterinary oncology diagnostics diagnostic pharmaceutical pharma immunology
dermatology cardiology cardiovascular neurology neuroscience orthopedic orthopaedic
surgical molecular laboratory dental animal health women's health womens health
specialty executive regional district
senior sr junior jr
`.trim().toLowerCase().split(/\s+/));
const ROLE_PATTERNS = [
  /(?:key |strategic |national |clinical |territory |district |regional |area )?account executive(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
  /(?:key |strategic |national )?account manager(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
  /(?:veterinary |clinical |territory |district |regional |area |national )?sales manager(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
  /(?:area |regional |national )?sales director(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
  /(?:clinical |territory |district |regional |area |national )?sales representative(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
  /(?:clinical |territory |district |regional |area )?sales (?:specialist|consultant|associate)(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
  /(?:territory |district |regional |area )?manager(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
  /(?:business development|practice development) (?:manager|representative|director)(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
  /clinical specialist(?:\s+(?:i{1,3}|iv|v|[1-5]))?/i,
];
function generalizedRole(job) {
  const raw = String(job.title_original || job.title_normalized || '')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:amp|#38);/gi, '&')
    .replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ')
    .replace(/[–—|;]+/g, '|').replace(/\s+-\s+/g, '|')
    .replace(/\s+/g, ' ').trim();
  // Retain a recognized role and vetted broad specialty words immediately
  // before it. Unknown wording triggers category fallback rather than leaking.
  for (const segment of raw.split('|')) {
    const text = segment.trim().replace(/[,:]+/g, ' ').replace(/\s+/g, ' ');
    for (const pattern of ROLE_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;
      const before = text.slice(0, match.index).trim();
      const prefix = before ? before.split(/\s+/) : [];
      // Unknown lead-in words may be a product, brand or company. Keep only
      // vetted role modifiers and the recognized functional role itself.
      const safePrefix = prefix.filter(word => SAFE_ROLE_PREFIXES.has(word.toLowerCase().replace(/[^a-z']/g, ''))).slice(-2);
      const phrase = [...safePrefix, ...match[0].trim().split(/\s+/)];
      return phrase.map(word => /^(?:i{1,3}|iv|v|[1-5])$/i.test(word) ? word.toUpperCase() :
        word[0].toUpperCase()+word.slice(1).toLowerCase()).join(' ');
    }
  }
  const labels = require('../public/rook-job-classification').classify(job).labels;
  const fallbacks = [
    ['Veterinary', 'Veterinary Sales Role'],
    ['Diagnostics', 'Diagnostics Sales Role'],
    ['Pharmaceutical', 'Pharmaceutical Sales Role'],
    ['Biotech/Life Sciences', 'Pharmaceutical Sales Role'],
    ['Medical Device', 'Medical Device Sales Role'],
  ];
  return fallbacks.find(([label]) => labels.includes(label))?.[1] || 'Sales Opportunity';
}
function safeSpecialty(job) {
  const allowed = new Map([
    ['capital equipment','Capital Equipment'], ['surgical','Surgical'], ['oncology','Oncology'],
    ['molecular diagnostics','Molecular Diagnostics'], ['laboratory diagnostics','Laboratory Diagnostics'],
    ['laboratory sales','Laboratory Sales'], ['companion animal','Companion Animal'],
    ['point-of-care','Point-of-Care'], ['animal health','Animal Health'], ['dental','Dental'],
    ['imaging','Imaging'], ['vaccines','Vaccines'], ['immunology','Immunology'],
    ['cardiology','Cardiology'], ['dermatology','Dermatology'], ['orthopedics','Orthopedics'],
  ]);
  const categories = Array.isArray(job.ai_analysis?.product_categories) ? job.ai_analysis.product_categories : [];
  for (const value of categories) {
    if (typeof value !== 'string') continue;
    const label = allowed.get(value.trim().toLowerCase());
    if (label) return label;
  }
  return null;
}
function freshness(job, now = Date.now(), detailed = false) {
  const posted = job.date_posted;
  const added = job.first_seen_at;
  const date = Date.parse((posted || added) || '');
  if (!Number.isFinite(date)) return detailed ? null : 'Current opportunity';
  const current = new Date(now), source = new Date(date);
  const currentDay = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const sourceDay = Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate());
  const days = Math.floor((currentDay-sourceDay)/86400000);
  if (!detailed) return days >= 0 && (now-date) < 14*86400000 ? 'Recently posted' : 'Current opportunity';
  if (days < 0) return null;
  const age = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `${posted ? 'Posted' : 'Added'} ${age}`;
}
module.exports = {maskedTitle, generalizedRole, safeSpecialty, freshness};
