const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', 'public');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'rook-employer-logos-v8.js'), 'utf8'), context);
const logo = context.window.RookV8EmployerLogo;
const examples = {
  'Abbott': 'abbott.svg', 'Medtronic': 'medtronic.svg', 'Stryker': 'stryker.svg',
  'AbbVie': 'abbvie.svg', 'Johnson & Johnson': 'johnson-and-johnson.svg',
  'Philips': 'philips.webp', 'GE HealthCare': 'ge-healthcare.svg',
  'IQVIA': 'iqvia.svg', 'Viatris': 'viatris.svg',
  'BD (Becton, Dickinson and Company)': 'bd.svg', 'Novartis': 'novartis.svg',
  'Smith+Nephew': 'smith-nephew.svg', 'Fresenius Medical Care': 'fresenius-medical-care.svg',
  'Baxter': 'baxter.svg', 'Regeneron': 'regeneron.svg',
  'Medical Sales College': 'medical-sales-college.png', 'AstraZeneca': 'astrazeneca.svg',
  'Edwards Lifesciences': 'edwards-lifesciences.svg', 'Intuitive Surgical': 'intuitive-surgical.svg',
  'Amgen': 'amgen.svg', 'Boston Scientific': 'boston-scientific.svg'
};
Object.assign(examples, {
  'Axsome Therapeutics': 'axsome-therapeutics.svg',
  'Bristol Myers Squibb': 'bristol-myers-squibb.svg',
  'Caris Life Sciences': 'caris-life-sciences.png',
  'CooperCompanies': 'coopercompanies.png',
  'Corcept Therapeutics': 'corcept-therapeutics.png',
  'DaVita': 'davita.png',
  'Fetch Pet Insurance': 'fetch-pet-insurance.png',
  'Fujifilm Healthcare': 'fujifilm-healthcare.svg',
  'Globus Medical': 'globus-medical.png',
  'Guardant Health': 'guardant-health.svg',
  'Haemonetics': 'haemonetics.png',
  'Integra LifeSciences': 'integra-lifesciences.webp',
  'Labcorp': 'labcorp.png',
  'Mars': 'mars.svg',
  'McKesson': 'mckesson.svg',
  'Merck': 'merck.svg',
  'MWI Animal Health (Cencora)': 'mwi-animal-health.svg',
  'Natera': 'natera.svg',
  'Nitra': 'nitra.png',
  'Olympus': 'olympus.png',
  'Organon': 'organon.svg',
  'QIAGEN': 'qiagen.png',
  'Sartorius': 'sartorius.svg',
  'STERIS': 'steris.png',
  'Tandem Health': 'tandem-health.svg',
  'Tempus AI': 'tempus-ai.svg',
  'Veeva Systems': 'veeva-systems.png'
});

for (const [company, filename] of Object.entries(examples)) {
  const markup = logo.render(company);
  assert(markup.includes(`assets/employer-logos/${filename}`), company);
  assert(fs.statSync(path.join(root, 'assets', 'employer-logos', filename)).size > 100, company);
  assert.equal(markup, logo.render(`  ${company}  `), 'same employer reuses its asset');
}
for (const company of ['Quest Diagnostics', 'Solventum', 'GSK', 'Select Medical', 'Insulet', 'Roche']) {
  assert(!logo.render(company).includes('<img'), `${company} must use its initial`);
}
assert(logo.render('Abbott').includes('onerror="this.remove()"'), 'failed asset retains initial');
assert(fs.readFileSync(path.join(root, 'rook-v8.js'), 'utf8').includes('revealed?RookV8EmployerLogo.render(employer):'), 'preview masked cards have no logo');
assert(fs.readFileSync(path.join(root, 'rook-dashboard-v8.html'), 'utf8').includes("job.subscription_required ? '' : RookV8EmployerLogo.render(companyName)"), 'locked member cards have no logo');
assert(fs.readFileSync(path.join(root, 'rook-employer-logos-v8.css'), 'utf8').includes('object-fit:contain'), 'logos preserve aspect ratio');
console.log('V8 employer logos: 48 curated mappings, reuse, fallback, and masked gating passed.');
