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

for (const [company, filename] of Object.entries(examples)) {
  const markup = logo.render(company);
  assert(markup.includes(`assets/employer-logos/${filename}`), company);
  assert(fs.statSync(path.join(root, 'assets', 'employer-logos', filename)).size > 100, company);
  assert.equal(markup, logo.render(`  ${company}  `), 'same employer reuses its asset');
}
for (const company of ['Quest Diagnostics', 'Solventum', 'GSK', 'Select Medical', 'Labcorp']) {
  assert(!logo.render(company).includes('<img'), `${company} must use its initial`);
}
assert(logo.render('Abbott').includes('onerror="this.remove()"'), 'failed asset retains initial');
assert(fs.readFileSync(path.join(root, 'rook-v8.js'), 'utf8').includes('revealed?RookV8EmployerLogo.render(employer):'), 'preview masked cards have no logo');
assert(fs.readFileSync(path.join(root, 'rook-dashboard-v8.html'), 'utf8').includes("job.subscription_required ? '' : RookV8EmployerLogo.render(companyName)"), 'locked member cards have no logo');
assert(fs.readFileSync(path.join(root, 'rook-employer-logos-v8.css'), 'utf8').includes('object-fit:contain'), 'logos preserve aspect ratio');
console.log('V8 employer logos: 21 curated mappings, reuse, fallback, and masked gating passed.');
